use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::*;

#[path = "horizontal_browse_transport_audio.rs"]
mod horizontal_browse_transport_audio;
#[path = "horizontal_browse_transport_engine_state.rs"]
mod horizontal_browse_transport_engine_state;
#[path = "horizontal_browse_transport_napi.rs"]
mod horizontal_browse_transport_napi;
#[path = "horizontal_browse_transport_runtime.rs"]
mod horizontal_browse_transport_runtime;
#[path = "horizontal_browse_transport_types.rs"]
mod horizontal_browse_transport_types;
pub use horizontal_browse_transport_napi::*;
use horizontal_browse_transport_runtime::{
  engine, execute_decode_request_sync, native_now_ms, next_snapshot_sequence,
  schedule_decode_request,
};
use horizontal_browse_transport_types::{
  parse_deck_id, BeatGridSnapshot, DeckDerivedState, DeckId, DecodeRequest,
};
pub use horizontal_browse_transport_types::{
  HorizontalBrowseTransportBeatGridInput, HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportDeckSnapshot, HorizontalBrowseTransportOutputSnapshot,
  HorizontalBrowseTransportSnapshot, HorizontalBrowseTransportStateInput,
  HorizontalBrowseTransportVisualizerSnapshot,
};

struct DeckState {
  file_path: Option<String>,
  loaded_file_path: Option<String>,
  fully_decoded_file_path: Option<String>,
  pending_decode_file_path: Option<String>,
  pending_full_decode_file_path: Option<String>,
  title: Option<String>,
  bpm: Option<f64>,
  first_beat_ms: Option<f64>,
  bar_beat_offset: Option<f64>,
  time_basis_offset_ms: Option<f64>,
  duration_sec: f64,
  current_sec: f64,
  last_observed_at_ms: f64,
  playing: bool,
  playback_rate: f64,
  master_tempo_enabled: bool,
  decode_request_id: u64,
  full_decode_request_id: u64,
  pcm_data: Arc<Vec<f32>>,
  pcm_start_sec: f64,
  sample_rate: u32,
  channels: u16,
  gain: f32,
  metronome_enabled: bool,
  metronome_volume_level: u8,
  metronome_state: MetronomeState,
  loop_active: bool,
  loop_beat_value: f64,
  loop_start_beat_index: Option<i32>,
  loop_start_sec: f64,
  loop_end_sec: f64,
  master_tempo_state: horizontal_browse_transport_audio::DeckMasterTempoState,
}

struct MetronomeState {
  next_beat_index: Option<i64>,
  click_elapsed_samples: u32,
  click_total_samples: u32,
  oscillator_phase: f64,
}

struct DecodeApplyBaseline {
  pcm_start_sec: f64,
  sample_rate: u32,
  channels: u16,
}

struct PreparedDecodedAudio {
  pcm_data: Arc<Vec<f32>>,
  pcm_start_sec: f64,
  sample_rate: u32,
  channels: u16,
  preserve_master_tempo_state: bool,
}

const HORIZONTAL_BROWSE_STARTUP_DECODE_SEC: f64 = 10.0;
const HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT: usize = 256;
const HORIZONTAL_BROWSE_LOOP_END_EPSILON_SEC: f64 = 0.0005;
const HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC: f64 = 0.0001;
const HORIZONTAL_BROWSE_LOOP_BEAT_INDEX_EPSILON: f64 = 1e-6;
const HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC: f64 = 1e-7;
const HORIZONTAL_BROWSE_METRONOME_TICK_FREQUENCY_HZ: f64 = 1560.0;
const HORIZONTAL_BROWSE_METRONOME_TICK_END_FREQUENCY_HZ: f64 = 1320.0;
const HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC: f64 = 0.002;
const HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC: f64 = 0.045;
const HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR: f32 = 0.0001;
const HORIZONTAL_BROWSE_METRONOME_VOLUME_LEVELS: [f32; 3] = [0.17, 0.32, 0.96];
const HORIZONTAL_BROWSE_LOOP_DEFAULT_BEAT_VALUE: f64 = 8.0;
const HORIZONTAL_BROWSE_LOOP_BEAT_VALUES: [f64; 16] = [
  1.0 / 64.0,
  1.0 / 32.0,
  1.0 / 16.0,
  1.0 / 8.0,
  1.0 / 4.0,
  1.0 / 2.0,
  1.0,
  2.0,
  4.0,
  8.0,
  16.0,
  32.0,
  64.0,
  128.0,
  256.0,
  512.0,
];

impl Default for MetronomeState {
  fn default() -> Self {
    Self {
      next_beat_index: None,
      click_elapsed_samples: 0,
      click_total_samples: 0,
      oscillator_phase: 0.0,
    }
  }
}

impl Default for DeckState {
  fn default() -> Self {
    Self {
      file_path: None,
      loaded_file_path: None,
      fully_decoded_file_path: None,
      pending_decode_file_path: None,
      pending_full_decode_file_path: None,
      title: None,
      bpm: None,
      first_beat_ms: None,
      bar_beat_offset: None,
      time_basis_offset_ms: None,
      duration_sec: 0.0,
      current_sec: 0.0,
      last_observed_at_ms: 0.0,
      playing: false,
      playback_rate: 1.0,
      master_tempo_enabled: true,
      decode_request_id: 0,
      full_decode_request_id: 0,
      pcm_data: Arc::new(Vec::new()),
      pcm_start_sec: 0.0,
      sample_rate: 0,
      channels: 0,
      gain: 1.0,
      metronome_enabled: false,
      metronome_volume_level: 2,
      metronome_state: MetronomeState::default(),
      loop_active: false,
      loop_beat_value: 8.0,
      loop_start_beat_index: None,
      loop_start_sec: 0.0,
      loop_end_sec: 0.0,
      master_tempo_state: horizontal_browse_transport_audio::DeckMasterTempoState::default(),
    }
  }
}

struct HorizontalBrowseTransportEngine {
  top: DeckState,
  bottom: DeckState,
  last_now_ms: f64,
  last_native_now_ms: f64,
  state_revision: u64,
  output_sample_rate: u32,
  output_channels: u16,
  leader: Option<DeckId>,
  sync_enabled: [bool; 2],
  sync_lock: [&'static str; 2],
  beat_distance: [f64; 2],
  target_beat_distance: [f64; 2],
  quantize_enabled: [bool; 2],
  bpm_multiplier: [f64; 2],
  trim_gain: [f32; 2],
  master_gain: f32,
  crossfader_value: f32,
  visualizer_ring: Vec<f32>,
  visualizer_write_index: usize,
  visualizer_filled: bool,
}

static OUTPUT_THREAD_STARTED: OnceLock<()> = OnceLock::new();

impl Default for HorizontalBrowseTransportEngine {
  fn default() -> Self {
    Self {
      top: DeckState::default(),
      bottom: DeckState::default(),
      last_now_ms: 0.0,
      last_native_now_ms: 0.0,
      state_revision: 0,
      output_sample_rate: 44100,
      output_channels: 2,
      leader: None,
      sync_enabled: [false, false],
      sync_lock: ["off", "off"],
      beat_distance: [0.0, 0.0],
      target_beat_distance: [0.0, 0.0],
      quantize_enabled: [true, true],
      bpm_multiplier: [1.0, 1.0],
      trim_gain: [1.0, 1.0],
      master_gain: 1.0,
      crossfader_value: 0.0,
      visualizer_ring: vec![0.0; HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT],
      visualizer_write_index: 0,
      visualizer_filled: false,
    }
  }
}

impl HorizontalBrowseTransportEngine {
  fn mark_state_changed(&mut self) {
    self.state_revision = self.state_revision.wrapping_add(1);
    if self.state_revision == 0 {
      self.state_revision = 1;
    }
  }

  fn observe_external_now_ms(&mut self, now_ms: f64) {
    if !now_ms.is_finite() || now_ms < 0.0 {
      return;
    }
    self.last_now_ms = now_ms;
    self.last_native_now_ms = native_now_ms();
  }

  fn current_external_now_ms(&self) -> f64 {
    if self.last_native_now_ms <= 0.0 {
      return self.last_now_ms;
    }
    self.last_now_ms + (native_now_ms() - self.last_native_now_ms).max(0.0)
  }

  fn resolve_loaded_segment_end_sec(&self, deck: DeckId) -> f64 {
    let deck_state = self.deck(deck);
    if deck_state.sample_rate == 0 || deck_state.channels == 0 {
      return deck_state.pcm_start_sec;
    }
    let frame_count = deck_state.pcm_data.len() / deck_state.channels as usize;
    deck_state.pcm_start_sec + frame_count as f64 / deck_state.sample_rate as f64
  }

  fn has_loaded_segment_covering(&self, deck: DeckId, target_sec: f64) -> bool {
    let deck_state = self.deck(deck);
    if deck_state.loaded_file_path.as_deref() != deck_state.file_path.as_deref() {
      return false;
    }
    if deck_state.pcm_data.is_empty() || deck_state.sample_rate == 0 || deck_state.channels == 0 {
      return false;
    }
    let safe_target_sec = Self::timeline_sec_to_audio_sec(deck_state, target_sec.max(0.0));
    safe_target_sec + 0.0001 >= deck_state.pcm_start_sec
      && safe_target_sec < self.resolve_loaded_segment_end_sec(deck) - 0.0001
  }

  fn is_fully_decoded(&self, deck: DeckId) -> bool {
    let deck_state = self.deck(deck);
    let file_path = deck_state
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    let fully_decoded_file_path = deck_state
      .fully_decoded_file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    !file_path.is_empty()
      && file_path == fully_decoded_file_path
      && deck_state.loaded_file_path.as_deref().map(str::trim) == Some(file_path)
      && deck_state.pcm_start_sec <= 0.0001
      && !deck_state.pcm_data.is_empty()
      && deck_state.sample_rate > 0
      && deck_state.channels > 0
  }

  fn is_playing_audible_at(&self, deck: DeckId, now_ms: f64) -> bool {
    let deck_state = self.deck(deck);
    if !deck_state.playing {
      return false;
    }
    let current_sec = Self::estimate_current_sec(deck_state, now_ms);
    self.has_loaded_segment_covering(deck, current_sec)
  }

  fn is_sync_ready(&self, deck: DeckId, now_ms: f64) -> bool {
    if !self.is_loaded(deck) {
      return false;
    }
    if !self.deck(deck).playing {
      return true;
    }
    self.is_playing_audible_at(deck, now_ms)
  }

  fn auto_select_leader_from_playback(&mut self) {
    let now_ms = self.last_now_ms;
    let top_audible = self.is_playing_audible_at(DeckId::Top, now_ms);
    let bottom_audible = self.is_playing_audible_at(DeckId::Bottom, now_ms);
    match (top_audible, bottom_audible) {
      (true, false) => {
        if self.leader.is_none() || !self.is_playing_audible_at(self.leader.unwrap(), now_ms) {
          self.leader = Some(DeckId::Top);
        }
      }
      (false, true) => {
        if self.leader.is_none() || !self.is_playing_audible_at(self.leader.unwrap(), now_ms) {
          self.leader = Some(DeckId::Bottom);
        }
      }
      _ => {
        if let Some(leader) = self.leader {
          if !self.is_sync_ready(leader, now_ms) {
            self.leader = None;
          }
        }
      }
    }
  }

  fn prepare_decode_request(&mut self, deck: DeckId) -> Option<DecodeRequest> {
    let file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim().to_string())
      .unwrap_or_default();
    if file_path.is_empty() {
      let target = self.deck_mut(deck);
      target.loaded_file_path = None;
      target.fully_decoded_file_path = None;
      target.pending_decode_file_path = None;
      target.pending_full_decode_file_path = None;
      target.pcm_data = Arc::new(Vec::new());
      target.pcm_start_sec = 0.0;
      target.sample_rate = 0;
      target.channels = 0;
      horizontal_browse_transport_audio::clear_master_tempo_state(target);
      self.mark_state_changed();
      return None;
    }
    if self.has_loaded_segment_covering(deck, 0.0) {
      return None;
    }
    if self.deck(deck).pending_decode_file_path.as_deref() == Some(file_path.as_str()) {
      return None;
    }
    let should_reset_loaded_audio =
      self.deck(deck).loaded_file_path.as_deref().map(str::trim) != Some(file_path.as_str());
    let target = self.deck_mut(deck);
    target.decode_request_id = target.decode_request_id.wrapping_add(1);
    let request_id = target.decode_request_id;
    target.pending_decode_file_path = Some(file_path.clone());
    if should_reset_loaded_audio {
      target.loaded_file_path = None;
      target.fully_decoded_file_path = None;
      target.pending_full_decode_file_path = None;
      target.pcm_data = Arc::new(Vec::new());
      target.pcm_start_sec = 0.0;
      target.sample_rate = 0;
      target.channels = 0;
      horizontal_browse_transport_audio::clear_master_tempo_state(target);
    }
    self.mark_state_changed();
    Some(DecodeRequest {
      deck,
      file_path,
      request_id,
      start_sec: 0.0,
      max_duration_sec: Some(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC),
      is_full_decode: false,
    })
  }

  fn prepare_full_decode_request(&mut self, deck: DeckId) -> Option<DecodeRequest> {
    let file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim().to_string())
      .unwrap_or_default();
    if file_path.is_empty() || self.is_fully_decoded(deck) {
      return None;
    }
    if !self.is_loaded(deck) {
      return None;
    }
    if self.deck(deck).pending_full_decode_file_path.as_deref() == Some(file_path.as_str()) {
      return None;
    }
    let target = self.deck_mut(deck);
    target.full_decode_request_id = target.full_decode_request_id.wrapping_add(1);
    let request_id = target.full_decode_request_id;
    target.pending_full_decode_file_path = Some(file_path.clone());
    self.mark_state_changed();
    Some(DecodeRequest {
      deck,
      file_path,
      request_id,
      start_sec: 0.0,
      max_duration_sec: None,
      is_full_decode: true,
    })
  }

  fn request_matches(
    &self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) -> bool {
    let current_state = self.deck(deck);
    let current_file_path = current_state
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    let request_matches = if fully_decoded {
      current_state.full_decode_request_id == request_id
    } else {
      current_state.decode_request_id == request_id
    };
    current_file_path == file_path && request_matches
  }

  fn capture_decode_apply_baseline(
    &self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) -> Option<DecodeApplyBaseline> {
    if !self.request_matches(deck, file_path, request_id, fully_decoded) {
      return None;
    }
    let deck_state = self.deck(deck);
    Some(DecodeApplyBaseline {
      pcm_start_sec: deck_state.pcm_start_sec,
      sample_rate: deck_state.sample_rate,
      channels: deck_state.channels,
    })
  }

  fn apply_prepared_decoded_audio(
    &mut self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    prepared: PreparedDecodedAudio,
    fully_decoded: bool,
  ) -> bool {
    if !self.request_matches(deck, file_path, request_id, fully_decoded) {
      return false;
    }
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let target = self.deck_mut(deck);
    let should_reset_master_tempo = !prepared.preserve_master_tempo_state
      || target.sample_rate != prepared.sample_rate
      || target.channels != prepared.channels
      || (target.pcm_start_sec - prepared.pcm_start_sec).abs() > 0.0001;
    target.loaded_file_path = Some(file_path.to_string());
    target.pcm_data = prepared.pcm_data;
    target.pcm_start_sec = prepared.pcm_start_sec;
    target.sample_rate = prepared.sample_rate;
    target.channels = prepared.channels;
    if fully_decoded {
      target.pending_full_decode_file_path = None;
      target.pending_decode_file_path = None;
      target.fully_decoded_file_path = Some(file_path.to_string());
      target.decode_request_id = target.decode_request_id.wrapping_add(1);
    } else {
      target.pending_decode_file_path = None;
      target.fully_decoded_file_path = None;
    }
    if should_reset_master_tempo {
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
      horizontal_browse_transport_audio::prime_master_tempo_state(target, output_sample_rate);
    }
    self.mark_state_changed();
    true
  }

  fn mark_decode_finished(
    &mut self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) {
    let current_state = self.deck(deck);
    let current_file_path = current_state
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    let full_decode_request_id = current_state.full_decode_request_id;
    if current_file_path != file_path {
      return;
    }
    let target = self.deck_mut(deck);
    if fully_decoded && full_decode_request_id == request_id {
      target.pending_full_decode_file_path = None;
    } else if !fully_decoded {
      target.pending_decode_file_path = None;
    }
    self.mark_state_changed();
  }

  fn ensure_output_stream(&mut self) -> napi::Result<()> {
    if OUTPUT_THREAD_STARTED.get().is_some() {
      return Ok(());
    }
    OUTPUT_THREAD_STARTED
      .set(())
      .map_err(|_| Error::from_reason("output thread already started"))?;
    thread::spawn(|| {
      let host = cpal::default_host();
      let Some(device) = host.default_output_device() else {
        eprintln!("[horizontal-browse-transport] no default output device");
        return;
      };
      let Ok(supported) = device.default_output_config() else {
        eprintln!("[horizontal-browse-transport] default output config failed");
        return;
      };
      {
        let mut engine = engine().lock();
        engine.output_sample_rate = supported.sample_rate().0;
        engine.output_channels = supported.channels();
      }
      let stream_config: cpal::StreamConfig = supported.clone().into();
      let stream_result = match supported.sample_format() {
        cpal::SampleFormat::F32 => {
          HorizontalBrowseTransportEngine::build_output_stream::<f32>(&device, &stream_config)
        }
        cpal::SampleFormat::I16 => {
          HorizontalBrowseTransportEngine::build_output_stream::<i16>(&device, &stream_config)
        }
        cpal::SampleFormat::U16 => {
          HorizontalBrowseTransportEngine::build_output_stream::<u16>(&device, &stream_config)
        }
        other => {
          eprintln!(
            "[horizontal-browse-transport] unsupported sample format: {:?}",
            other
          );
          return;
        }
      };
      let Ok(stream) = stream_result else {
        eprintln!("[horizontal-browse-transport] build output stream failed");
        return;
      };
      if let Err(err) = stream.play() {
        eprintln!(
          "[horizontal-browse-transport] play output stream failed: {}",
          err
        );
        return;
      }
      loop {
        thread::sleep(Duration::from_secs(60));
        let _keep_alive = &stream;
      }
    });
    Ok(())
  }

  fn build_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
  ) -> napi::Result<cpal::Stream>
  where
    T: cpal::SizedSample + cpal::FromSample<f32>,
  {
    let channels = config.channels as usize;
    let err_fn = |err| {
      eprintln!("[horizontal-browse-transport] output stream error: {}", err);
    };
    device
      .build_output_stream(
        config,
        move |data: &mut [T], _| {
          let mut engine = engine().lock();
          for frame in data.chunks_mut(channels) {
            let (left, right) = engine.mix_output_frame();
            if let Some(sample) = frame.get_mut(0) {
              *sample = T::from_sample(left);
            }
            if channels >= 2 {
              if let Some(sample) = frame.get_mut(1) {
                *sample = T::from_sample(right);
              }
              for channel in 2..channels {
                if let Some(sample) = frame.get_mut(channel) {
                  *sample = T::from_sample((left + right) * 0.5);
                }
              }
            }
          }
        },
        err_fn,
        None,
      )
      .map_err(|err| Error::from_reason(format!("build output stream failed: {}", err)))
  }

  fn mix_output_frame(&mut self) -> (f32, f32) {
    let mut left = 0.0_f32;
    let mut right = 0.0_f32;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let (l, r) = self.sample_deck(deck);
      left += l;
      right += r;
    }
    let clamped_left = left.clamp(-1.0, 1.0);
    let clamped_right = right.clamp(-1.0, 1.0);
    self.push_visualizer_sample((clamped_left + clamped_right) * 0.5);
    (clamped_left, clamped_right)
  }

  fn sample_deck(&mut self, deck: DeckId) -> (f32, f32) {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let before_sec = self.deck(deck).current_sec;
    let was_playing = self.deck(deck).playing;
    let target = self.deck_mut(deck);
    let (deck_left, deck_right) =
      horizontal_browse_transport_audio::sample_deck(target, output_sample_rate);
    let after_sec = self.deck(deck).current_sec;
    let metronome =
      self.sample_metronome(deck, before_sec, after_sec, was_playing) * self.deck(deck).gain;
    (deck_left + metronome, deck_right + metronome)
  }

  fn resolve_next_metronome_beat_index(current_sec: f64, grid: BeatGridSnapshot) -> i64 {
    let raw = (current_sec - grid.first_beat_sec) / grid.beat_sec;
    let epsilon_beats = HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC / grid.beat_sec;
    let mut index = (raw - epsilon_beats).ceil() as i64;
    while grid.first_beat_sec + index as f64 * grid.beat_sec < 0.0 {
      index += 1;
    }
    index
  }

  fn maybe_trigger_metronome(
    target: &mut DeckState,
    grid: BeatGridSnapshot,
    before_sec: f64,
    after_sec: f64,
    was_playing: bool,
    output_sample_rate: f64,
  ) {
    if !target.metronome_enabled
      || !was_playing
      || !target.playing
      || target.pcm_data.is_empty()
      || target.sample_rate == 0
      || target.channels == 0
      || !before_sec.is_finite()
      || !after_sec.is_finite()
      || !grid.beat_sec.is_finite()
      || grid.beat_sec <= 0.0
    {
      target.metronome_state.next_beat_index = None;
      target.metronome_state.click_elapsed_samples = 0;
      target.metronome_state.click_total_samples = 0;
      return;
    }

    let expected_index = Self::resolve_next_metronome_beat_index(before_sec.max(0.0), grid);
    let mut next_index = target
      .metronome_state
      .next_beat_index
      .unwrap_or(expected_index);
    if next_index < expected_index || next_index > expected_index + 1 {
      next_index = expected_index;
    }

    let beat_time_sec = grid.first_beat_sec + next_index as f64 * grid.beat_sec;
    if beat_time_sec >= before_sec - HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC
      && beat_time_sec <= after_sec + HORIZONTAL_BROWSE_METRONOME_BEAT_EPSILON_SEC
    {
      target.metronome_state.click_elapsed_samples = 0;
      target.metronome_state.click_total_samples =
        (HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC * output_sample_rate).ceil() as u32;
      target.metronome_state.oscillator_phase = 0.0;
      next_index += 1;
    }

    target.metronome_state.next_beat_index = Some(next_index);
  }

  fn sample_metronome_click(target: &mut DeckState, output_sample_rate: f64) -> f32 {
    let state = &mut target.metronome_state;
    if state.click_elapsed_samples >= state.click_total_samples || state.click_total_samples == 0 {
      return 0.0;
    }

    let elapsed_sec = state.click_elapsed_samples as f64 / output_sample_rate.max(1.0);
    let progress = (elapsed_sec / HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC).clamp(0.0, 1.0);
    let frequency = HORIZONTAL_BROWSE_METRONOME_TICK_FREQUENCY_HZ
      * (HORIZONTAL_BROWSE_METRONOME_TICK_END_FREQUENCY_HZ
        / HORIZONTAL_BROWSE_METRONOME_TICK_FREQUENCY_HZ)
        .powf(progress);
    state.oscillator_phase = (state.oscillator_phase
      + std::f64::consts::TAU * frequency / output_sample_rate.max(1.0))
      % std::f64::consts::TAU;
    let wave = Self::band_limited_square(
      state.oscillator_phase,
      frequency,
      output_sample_rate.max(1.0),
    );
    let volume_index = target.metronome_volume_level.saturating_sub(1) as usize;
    let volume = HORIZONTAL_BROWSE_METRONOME_VOLUME_LEVELS
      .get(volume_index)
      .copied()
      .unwrap_or(HORIZONTAL_BROWSE_METRONOME_VOLUME_LEVELS[1]);
    let envelope = if elapsed_sec < HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC {
      Self::exponential_ramp(
        HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR,
        volume,
        elapsed_sec / HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC,
      )
    } else {
      let decay_sec =
        HORIZONTAL_BROWSE_METRONOME_TICK_DURATION_SEC - HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC;
      Self::exponential_ramp(
        volume,
        HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR,
        (elapsed_sec - HORIZONTAL_BROWSE_METRONOME_TICK_ATTACK_SEC) / decay_sec,
      )
    };
    state.click_elapsed_samples = state.click_elapsed_samples.saturating_add(1);
    wave * envelope
  }

  fn band_limited_square(phase: f64, frequency: f64, output_sample_rate: f64) -> f32 {
    if !frequency.is_finite() || frequency <= 0.0 {
      return 0.0;
    }
    let nyquist = output_sample_rate.max(1.0) * 0.5;
    let max_odd_harmonic = ((nyquist / frequency).floor() as i32).max(1).min(31);
    let mut harmonic = 1;
    let mut sum = 0.0_f64;
    while harmonic <= max_odd_harmonic {
      sum += (phase * harmonic as f64).sin() / harmonic as f64;
      harmonic += 2;
    }
    ((4.0 / std::f64::consts::PI) * sum).clamp(-1.0, 1.0) as f32
  }

  fn exponential_ramp(start: f32, end: f32, progress: f64) -> f32 {
    let safe_start = start.max(HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR);
    let safe_end = end.max(HORIZONTAL_BROWSE_METRONOME_GAIN_FLOOR);
    let ratio = safe_end / safe_start;
    safe_start * ratio.powf(progress.clamp(0.0, 1.0) as f32)
  }

  fn sample_metronome(
    &mut self,
    deck: DeckId,
    before_sec: f64,
    after_sec: f64,
    was_playing: bool,
  ) -> f32 {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let grid = self.beat_grid(deck);
    let target = self.deck_mut(deck);
    if let Some(grid) = grid {
      Self::maybe_trigger_metronome(
        target,
        grid,
        before_sec,
        after_sec,
        was_playing,
        output_sample_rate,
      );
    } else {
      target.metronome_state.next_beat_index = None;
      target.metronome_state.click_elapsed_samples = 0;
      target.metronome_state.click_total_samples = 0;
    }
    Self::sample_metronome_click(target, output_sample_rate)
  }

  fn push_visualizer_sample(&mut self, sample: f32) {
    if self.visualizer_ring.len() != HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT {
      self.visualizer_ring = vec![0.0; HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT];
      self.visualizer_write_index = 0;
      self.visualizer_filled = false;
    }
    if self.visualizer_ring.is_empty() {
      return;
    }
    self.visualizer_ring[self.visualizer_write_index] = sample.clamp(-1.0, 1.0);
    self.visualizer_write_index =
      (self.visualizer_write_index + 1) % HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT;
    if self.visualizer_write_index == 0 {
      self.visualizer_filled = true;
    }
  }

  fn visualizer_snapshot(&self) -> HorizontalBrowseTransportVisualizerSnapshot {
    let sample_count = HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT;
    if self.visualizer_ring.len() != sample_count {
      return HorizontalBrowseTransportVisualizerSnapshot {
        time_domain_data: vec![128; sample_count],
      };
    }
    let available = if self.visualizer_filled {
      sample_count
    } else {
      self.visualizer_write_index.min(sample_count)
    };
    let mut time_domain_data = Vec::with_capacity(sample_count);
    for _ in available..sample_count {
      time_domain_data.push(128);
    }
    if available == 0 {
      return HorizontalBrowseTransportVisualizerSnapshot { time_domain_data };
    }
    let start_index = if self.visualizer_filled {
      self.visualizer_write_index
    } else {
      0
    };
    for offset in 0..available {
      let index = (start_index + offset) % sample_count;
      let sample = self.visualizer_ring.get(index).copied().unwrap_or(0.0);
      let encoded = ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * 255.0).round() as i32;
      time_domain_data.push(encoded.clamp(0, 255) as u8);
    }
    HorizontalBrowseTransportVisualizerSnapshot { time_domain_data }
  }

  fn deck(&self, deck: DeckId) -> &DeckState {
    match deck {
      DeckId::Top => &self.top,
      DeckId::Bottom => &self.bottom,
    }
  }

  fn deck_mut(&mut self, deck: DeckId) -> &mut DeckState {
    match deck {
      DeckId::Top => &mut self.top,
      DeckId::Bottom => &mut self.bottom,
    }
  }

  fn deck_index(deck: DeckId) -> usize {
    match deck {
      DeckId::Top => 0,
      DeckId::Bottom => 1,
    }
  }

  fn clamp_unit_gain(value: f64) -> f32 {
    if value.is_finite() {
      value.clamp(0.0, 1.0) as f32
    } else {
      1.0
    }
  }

  fn clamp_crossfader_value(value: f64) -> f32 {
    if value.is_finite() {
      value.clamp(-1.0, 1.0) as f32
    } else {
      0.0
    }
  }

  fn normalize_playback_rate(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
      value.clamp(0.25, 4.0)
    } else {
      1.0
    }
  }

  fn sync_master_tempo_state_after_change(
    &mut self,
    deck: DeckId,
    was_active: bool,
    force_reset: bool,
  ) {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let is_active = horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    let target = self.deck_mut(deck);
    if is_active {
      if force_reset || !was_active {
        horizontal_browse_transport_audio::reset_master_tempo_state(target);
      }
      horizontal_browse_transport_audio::prime_master_tempo_state(target, output_sample_rate);
      return;
    }
    if was_active || force_reset {
      horizontal_browse_transport_audio::clear_master_tempo_state(target);
    }
  }

  fn reset_and_prime_master_tempo_state(&mut self, deck: DeckId) {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let target = self.deck_mut(deck);
    horizontal_browse_transport_audio::reset_master_tempo_state(target);
    horizontal_browse_transport_audio::prime_master_tempo_state(target, output_sample_rate);
  }

  fn resolve_crossfader_volumes(value: f32) -> (f32, f32) {
    let safe_value = value.clamp(-1.0, 1.0);
    if safe_value >= 0.0 {
      (1.0, 1.0 - safe_value)
    } else {
      (1.0 + safe_value, 1.0)
    }
  }

  fn refresh_output_gains(&mut self) {
    let (top_crossfader_gain, bottom_crossfader_gain) =
      Self::resolve_crossfader_volumes(self.crossfader_value);
    let top_gain =
      self.trim_gain[Self::deck_index(DeckId::Top)] * self.master_gain * top_crossfader_gain;
    let bottom_gain =
      self.trim_gain[Self::deck_index(DeckId::Bottom)] * self.master_gain * bottom_crossfader_gain;
    self.top.gain = top_gain.clamp(0.0, 1.0);
    self.bottom.gain = bottom_gain.clamp(0.0, 1.0);
  }

  fn is_loaded(&self, deck: DeckId) -> bool {
    let deck_state = self.deck(deck);
    let file_path = deck_state
      .file_path
      .as_ref()
      .map(|path| path.trim())
      .unwrap_or("");
    let loaded_file_path = deck_state
      .loaded_file_path
      .as_ref()
      .map(|path| path.trim())
      .unwrap_or("");
    !file_path.is_empty()
      && file_path == loaded_file_path
      && !deck_state.pcm_data.is_empty()
      && deck_state.sample_rate > 0
      && deck_state.channels > 0
  }

  fn set_sync_lock(&mut self, deck: DeckId, next: &'static str) {
    let index = Self::deck_index(deck);
    self.sync_lock[index] = if self.sync_enabled[index] {
      next
    } else {
      "off"
    };
  }
}

fn prepare_decoded_audio(
  baseline: Option<DecodeApplyBaseline>,
  samples: Vec<f32>,
  sample_rate: u32,
  channels: u16,
  start_sec: f64,
  fully_decoded: bool,
) -> PreparedDecodedAudio {
  let pcm_start_sec = if fully_decoded {
    0.0
  } else {
    start_sec.max(0.0)
  };
  let preserve_master_tempo_state = baseline
    .as_ref()
    .map(|existing| {
      existing.sample_rate == sample_rate
        && existing.channels == channels
        && (existing.pcm_start_sec - pcm_start_sec).abs() <= 0.0001
    })
    .unwrap_or(false);
  PreparedDecodedAudio {
    pcm_data: Arc::new(samples),
    pcm_start_sec,
    sample_rate,
    channels,
    preserve_master_tempo_state,
  }
}

#[cfg(test)]
#[path = "horizontal_browse_transport_tests.rs"]
mod horizontal_browse_transport_tests;
