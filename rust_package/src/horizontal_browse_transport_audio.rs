use super::DeckState;
use std::ffi::c_void;

const MIN_RATE: f64 = 0.25;
const MAX_RATE: f64 = 4.0;
const MASTER_TEMPO_FEED_FRAMES: usize = 4096;
const MASTER_TEMPO_PULL_FRAMES: usize = 4096;

const ST_SETTING_USE_QUICKSEEK: i32 = 2;

unsafe extern "C" {
  fn frkb_soundtouch_create() -> *mut c_void;
  fn frkb_soundtouch_destroy(handle: *mut c_void);
  fn frkb_soundtouch_set_channels(handle: *mut c_void, channels: u32);
  fn frkb_soundtouch_set_sample_rate(handle: *mut c_void, sample_rate: u32);
  fn frkb_soundtouch_set_tempo(handle: *mut c_void, tempo: f64);
  fn frkb_soundtouch_set_pitch(handle: *mut c_void, pitch: f64);
  fn frkb_soundtouch_set_rate(handle: *mut c_void, rate: f64);
  fn frkb_soundtouch_set_setting(handle: *mut c_void, setting_id: i32, value: i32);
  fn frkb_soundtouch_put_samples(handle: *mut c_void, samples: *const f32, num_samples: u32);
  fn frkb_soundtouch_receive_samples(
    handle: *mut c_void,
    output: *mut f32,
    max_samples: u32,
  ) -> u32;
  fn frkb_soundtouch_flush(handle: *mut c_void);
}

struct SoundTouchHandle(*mut c_void);

unsafe impl Send for SoundTouchHandle {}

impl SoundTouchHandle {
  fn new(channels: u32, sample_rate: u32, tempo: f64) -> Option<Self> {
    let handle = unsafe { frkb_soundtouch_create() };
    if handle.is_null() {
      return None;
    }
    unsafe {
      frkb_soundtouch_set_channels(handle, channels);
      frkb_soundtouch_set_sample_rate(handle, sample_rate);
      frkb_soundtouch_set_tempo(handle, tempo);
      frkb_soundtouch_set_pitch(handle, 1.0);
      frkb_soundtouch_set_rate(handle, 1.0);
      frkb_soundtouch_set_setting(handle, ST_SETTING_USE_QUICKSEEK, 1);
    }
    Some(Self(handle))
  }

  fn set_tempo(&mut self, tempo: f64) {
    unsafe { frkb_soundtouch_set_tempo(self.0, tempo) }
  }

  fn put_samples(&mut self, samples: &[f32], num_samples: usize) {
    if samples.is_empty() || num_samples == 0 {
      return;
    }
    unsafe { frkb_soundtouch_put_samples(self.0, samples.as_ptr(), num_samples as u32) }
  }

  fn receive_samples(&mut self, output: &mut [f32], max_samples: usize) -> usize {
    if output.is_empty() || max_samples == 0 {
      return 0;
    }
    unsafe {
      frkb_soundtouch_receive_samples(self.0, output.as_mut_ptr(), max_samples as u32) as usize
    }
  }

  fn flush(&mut self) {
    unsafe { frkb_soundtouch_flush(self.0) }
  }
}

impl Drop for SoundTouchHandle {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { frkb_soundtouch_destroy(self.0) }
      self.0 = std::ptr::null_mut();
    }
  }
}

pub(super) struct DeckMasterTempoState {
  processor: Option<SoundTouchHandle>,
  channels: usize,
  source_frame_cursor: usize,
  playhead_source_frame: f64,
  output_buffer: Vec<f32>,
  output_offset: usize,
  staging_input: Vec<f32>,
  staging_output: Vec<f32>,
  flushed: bool,
}

impl Default for DeckMasterTempoState {
  fn default() -> Self {
    Self {
      processor: None,
      channels: 2,
      source_frame_cursor: 0,
      playhead_source_frame: 0.0,
      output_buffer: Vec::new(),
      output_offset: 0,
      staging_input: Vec::new(),
      staging_output: Vec::new(),
      flushed: false,
    }
  }
}

fn clamp_rate(value: f64) -> f64 {
  if value.is_finite() && value > 0.0 {
    value.clamp(MIN_RATE, MAX_RATE)
  } else {
    1.0
  }
}

fn resolved_channels(target: &DeckState) -> usize {
  target.channels.max(1).min(2) as usize
}

fn configure_processor(target: &mut DeckState) {
  let channels = resolved_channels(target);
  if target.sample_rate == 0 {
    target.master_tempo_state.processor = None;
    return;
  }
  let processor = SoundTouchHandle::new(
    channels as u32,
    target.sample_rate,
    clamp_rate(target.playback_rate),
  );
  target.master_tempo_state.channels = channels;
  target.master_tempo_state.processor = processor;
  target
    .master_tempo_state
    .staging_output
    .resize(channels * MASTER_TEMPO_PULL_FRAMES, 0.0);
}

pub(super) fn reset_master_tempo_state(target: &mut DeckState) {
  target.master_tempo_state.source_frame_cursor =
    ((target.current_sec - target.pcm_start_sec).max(0.0) * target.sample_rate as f64).floor()
      as usize;
  target.master_tempo_state.playhead_source_frame =
    ((target.current_sec - target.pcm_start_sec).max(0.0)) * target.sample_rate as f64;
  target.master_tempo_state.output_buffer.clear();
  target.master_tempo_state.output_offset = 0;
  target.master_tempo_state.flushed = false;
  configure_processor(target);
}

fn append_source_chunk(target: &mut DeckState) -> bool {
  let channels = target.master_tempo_state.channels.max(1);
  let frame_count = target.pcm_data.len() / target.channels.max(1) as usize;
  let start_frame = target
    .master_tempo_state
    .source_frame_cursor
    .min(frame_count);
  if start_frame >= frame_count {
    return false;
  }
  let end_frame = (start_frame + MASTER_TEMPO_FEED_FRAMES).min(frame_count);
  let frames_to_feed = end_frame - start_frame;
  target
    .master_tempo_state
    .staging_input
    .resize(frames_to_feed * channels, 0.0);

  let source_channels = target.channels.max(1) as usize;
  for frame_offset in 0..frames_to_feed {
    for channel in 0..channels {
      let source_channel = channel.min(source_channels - 1);
      let sample = target
        .pcm_data
        .get((start_frame + frame_offset) * source_channels + source_channel)
        .copied()
        .unwrap_or(0.0);
      target.master_tempo_state.staging_input[frame_offset * channels + channel] = sample;
    }
  }

  if let Some(processor) = target.master_tempo_state.processor.as_mut() {
    processor.set_tempo(clamp_rate(target.playback_rate));
    processor.put_samples(
      &target.master_tempo_state.staging_input,
      target.master_tempo_state.staging_input.len() / channels,
    );
  }
  target.master_tempo_state.source_frame_cursor = end_frame;
  true
}

fn pull_processed_output(target: &mut DeckState) -> usize {
  let channels = target.master_tempo_state.channels.max(1);
  let Some(processor) = target.master_tempo_state.processor.as_mut() else {
    return 0;
  };
  processor.set_tempo(clamp_rate(target.playback_rate));
  let received = processor.receive_samples(
    target.master_tempo_state.staging_output.as_mut_slice(),
    MASTER_TEMPO_PULL_FRAMES,
  );
  if received > 0 {
    let sample_count = received * channels;
    target
      .master_tempo_state
      .output_buffer
      .extend_from_slice(&target.master_tempo_state.staging_output[..sample_count]);
  }
  received
}

fn ensure_output_samples(target: &mut DeckState) {
  let channels = target.master_tempo_state.channels.max(1);
  loop {
    let available_frames = (target.master_tempo_state.output_buffer.len()
      - target.master_tempo_state.output_offset)
      / channels;
    if available_frames > 0 {
      return;
    }

    if pull_processed_output(target) > 0 {
      continue;
    }

    if append_source_chunk(target) {
      continue;
    }

    if !target.master_tempo_state.flushed {
      if let Some(processor) = target.master_tempo_state.processor.as_mut() {
        processor.flush();
      }
      target.master_tempo_state.flushed = true;
      continue;
    }

    return;
  }
}

fn sample_deck_rate(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  let frame_count = target.pcm_data.len() / target.channels as usize;
  if frame_count == 0 {
    return (0.0, 0.0);
  }
  let source_frame =
    ((target.current_sec - target.pcm_start_sec).max(0.0)) * target.sample_rate as f64;
  let base_index = source_frame.floor() as usize;
  if base_index >= frame_count {
    return (0.0, 0.0);
  }
  let frac = (source_frame - base_index as f64) as f32;
  let next_index = (base_index + 1).min(frame_count - 1);
  let channels = target.channels as usize;
  let read_sample = |frame_index: usize, channel: usize, data: &[f32]| -> f32 {
    data
      .get(frame_index * channels + channel.min(channels - 1))
      .copied()
      .unwrap_or(0.0)
  };
  let pcm_data = target.pcm_data.as_ref().as_slice();
  let l0 = read_sample(base_index, 0, pcm_data);
  let l1 = read_sample(next_index, 0, pcm_data);
  let r0 = read_sample(
    base_index,
    if channels > 1 { 1 } else { 0 },
    pcm_data,
  );
  let r1 = read_sample(
    next_index,
    if channels > 1 { 1 } else { 0 },
    pcm_data,
  );
  let left = l0 + (l1 - l0) * frac;
  let right = r0 + (r1 - r0) * frac;

  let rate = clamp_rate(target.playback_rate);
  target.current_sec += rate / output_sample_rate;
  target.last_observed_at_ms = -1.0;
  if target.duration_sec.is_finite() && target.current_sec >= target.duration_sec {
    target.current_sec = target.duration_sec;
    target.playing = false;
  }
  (left * target.gain, right * target.gain)
}

fn sample_deck_master_tempo(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  if target.master_tempo_state.processor.is_none() {
    configure_processor(target);
  }
  ensure_output_samples(target);

  let channels = target.master_tempo_state.channels.max(1);
  let available_frames = (target.master_tempo_state.output_buffer.len()
    - target.master_tempo_state.output_offset)
    / channels;
  if available_frames == 0 {
    return (0.0, 0.0);
  }

  let base = target.master_tempo_state.output_offset;
  let left = target
    .master_tempo_state
    .output_buffer
    .get(base)
    .copied()
    .unwrap_or(0.0);
  let right = target
    .master_tempo_state
    .output_buffer
    .get(base + if channels > 1 { 1 } else { 0 })
    .copied()
    .unwrap_or(left);
  target.master_tempo_state.output_offset += channels;
  if target.master_tempo_state.output_offset >= target.master_tempo_state.output_buffer.len() {
    target.master_tempo_state.output_buffer.clear();
    target.master_tempo_state.output_offset = 0;
  } else if target.master_tempo_state.output_offset > channels * MASTER_TEMPO_PULL_FRAMES {
    target
      .master_tempo_state
      .output_buffer
      .drain(..target.master_tempo_state.output_offset);
    target.master_tempo_state.output_offset = 0;
  }

  target.master_tempo_state.playhead_source_frame +=
    clamp_rate(target.playback_rate) * target.sample_rate as f64 / output_sample_rate.max(1.0);
  target.current_sec = target.pcm_start_sec
    + target.master_tempo_state.playhead_source_frame / target.sample_rate as f64;
  target.last_observed_at_ms = -1.0;

  if target.duration_sec.is_finite() && target.current_sec >= target.duration_sec {
    target.current_sec = target.duration_sec;
    target.playing = false;
  }

  (left * target.gain, right * target.gain)
}

pub(super) fn sample_deck(target: &mut DeckState, output_sample_rate: f64) -> (f32, f32) {
  if !target.playing
    || target.pcm_data.is_empty()
    || target.sample_rate == 0
    || target.channels == 0
  {
    return (0.0, 0.0);
  }
  if target.master_tempo_enabled && (target.playback_rate - 1.0).abs() > 0.0001 {
    return sample_deck_master_tempo(target, output_sample_rate);
  }
  sample_deck_rate(target, output_sample_rate)
}
