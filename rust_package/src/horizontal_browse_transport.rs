use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::*;
use parking_lot::Mutex;

#[path = "horizontal_browse_transport_audio.rs"]
mod horizontal_browse_transport_audio;
#[path = "horizontal_browse_transport_types.rs"]
mod horizontal_browse_transport_types;
use horizontal_browse_transport_types::{
  parse_deck_id, BeatGridSnapshot, DeckDerivedState, DeckId, DecodeRequest,
  HorizontalBrowseTransportDeckInput, HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot, HorizontalBrowseTransportStateInput,
  HorizontalBrowseTransportVisualizerSnapshot,
};

struct DeckState {
  file_path: Option<String>,
  loaded_file_path: Option<String>,
  pending_decode_file_path: Option<String>,
  pending_full_decode_file_path: Option<String>,
  title: Option<String>,
  bpm: Option<f64>,
  first_beat_ms: Option<f64>,
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
  master_tempo_state: horizontal_browse_transport_audio::DeckMasterTempoState,
}

struct DecodeMergeBaseline {
  pcm_data: Arc<Vec<f32>>,
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

const HORIZONTAL_BROWSE_BOOTSTRAP_SEGMENT_DECODE_SEC: f64 = 12.0;
const HORIZONTAL_BROWSE_SYNC_SEGMENT_DECODE_SEC: f64 = 4.0;
const HORIZONTAL_BROWSE_IMMEDIATE_PLAY_SEGMENT_DECODE_SEC: f64 = 12.0;
const HORIZONTAL_BROWSE_ASYNC_SEGMENT_DECODE_SEC: f64 = 16.0;
const HORIZONTAL_BROWSE_SEGMENT_PREFETCH_THRESHOLD_SEC: f64 = 8.0;
const HORIZONTAL_BROWSE_SEGMENT_PREFETCH_OVERLAP_SEC: f64 = 4.0;
const HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT: usize = 256;

impl Default for DeckState {
  fn default() -> Self {
    Self {
      file_path: None,
      loaded_file_path: None,
      pending_decode_file_path: None,
      pending_full_decode_file_path: None,
      title: None,
      bpm: None,
      first_beat_ms: None,
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
      master_tempo_state: horizontal_browse_transport_audio::DeckMasterTempoState::default(),
    }
  }
}

struct HorizontalBrowseTransportEngine {
  top: DeckState,
  bottom: DeckState,
  last_now_ms: f64,
  output_sample_rate: u32,
  output_channels: u16,
  leader: Option<DeckId>,
  sync_enabled: [bool; 2],
  sync_lock: [&'static str; 2],
  beat_distance: [f64; 2],
  target_beat_distance: [f64; 2],
  quantize_enabled: [bool; 2],
  bpm_multiplier: [f64; 2],
  visualizer_ring: Vec<f32>,
  visualizer_write_index: usize,
  visualizer_filled: bool,
}

impl Default for HorizontalBrowseTransportEngine {
  fn default() -> Self {
    Self {
      top: DeckState::default(),
      bottom: DeckState::default(),
      last_now_ms: 0.0,
      output_sample_rate: 44100,
      output_channels: 2,
      leader: None,
      sync_enabled: [false, false],
      sync_lock: ["off", "off"],
      beat_distance: [0.0, 0.0],
      target_beat_distance: [0.0, 0.0],
      quantize_enabled: [true, true],
      bpm_multiplier: [1.0, 1.0],
      visualizer_ring: vec![0.0; HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT],
      visualizer_write_index: 0,
      visualizer_filled: false,
    }
  }
}

impl HorizontalBrowseTransportEngine {
  fn resolve_bootstrap_segment_start_sec(&self, deck: DeckId) -> f64 {
    let deck_state = self.deck(deck);
    deck_state
      .current_sec
      .max(0.0)
      .min(deck_state.duration_sec.max(0.0))
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
    let safe_target_sec = target_sec.max(0.0);
    safe_target_sec + 0.0001 >= deck_state.pcm_start_sec
      && safe_target_sec < self.resolve_loaded_segment_end_sec(deck) - 0.0001
  }

  fn auto_select_leader_from_playback(&mut self) {
    let top_playing = self.deck(DeckId::Top).playing;
    let bottom_playing = self.deck(DeckId::Bottom).playing;
    match (top_playing, bottom_playing) {
      (true, false) => {
        if self.leader.is_none() || !self.deck(self.leader.unwrap()).playing {
          self.leader = Some(DeckId::Top);
        }
      }
      (false, true) => {
        if self.leader.is_none() || !self.deck(self.leader.unwrap()).playing {
          self.leader = Some(DeckId::Bottom);
        }
      }
      _ => {
        if let Some(leader) = self.leader {
          if !self.is_loaded(leader) {
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
      target.pending_decode_file_path = None;
      target.pending_full_decode_file_path = None;
      target.pcm_data = Arc::new(Vec::new());
      target.pcm_start_sec = 0.0;
      target.sample_rate = 0;
      target.channels = 0;
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
      return None;
    }
    if self.has_loaded_segment_covering(deck, self.resolve_bootstrap_segment_start_sec(deck)) {
      return None;
    }
    if self.deck(deck).pending_decode_file_path.as_deref() == Some(file_path.as_str()) {
      return None;
    }
    let target = self.deck_mut(deck);
    target.decode_request_id = target.decode_request_id.wrapping_add(1);
    let request_id = target.decode_request_id;
    target.loaded_file_path = None;
    target.pending_decode_file_path = Some(file_path.clone());
    target.pcm_data = Arc::new(Vec::new());
    target.pcm_start_sec = 0.0;
    target.sample_rate = 0;
    target.channels = 0;
    horizontal_browse_transport_audio::reset_master_tempo_state(target);
    Some(DecodeRequest {
      deck,
      file_path,
      request_id,
      start_sec: self.resolve_bootstrap_segment_start_sec(deck),
      max_duration_sec: Some(HORIZONTAL_BROWSE_BOOTSTRAP_SEGMENT_DECODE_SEC),
      is_full_decode: false,
    })
  }

  fn prepare_segment_decode_request(
    &mut self,
    deck: DeckId,
    target_sec: f64,
    max_duration_sec: f64,
    allow_loaded_overlap: bool,
  ) -> Option<DecodeRequest> {
    let file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim().to_string())
      .unwrap_or_default();
    if file_path.is_empty() {
      return None;
    }
    let clamped_target_sec = target_sec
      .max(0.0)
      .min(self.deck(deck).duration_sec.max(0.0));
    if !allow_loaded_overlap && self.has_loaded_segment_covering(deck, clamped_target_sec) {
      return None;
    }
    let target = self.deck_mut(deck);
    target.decode_request_id = target.decode_request_id.wrapping_add(1);
    target.pending_decode_file_path = Some(file_path.clone());
    Some(DecodeRequest {
      deck,
      file_path,
      request_id: target.decode_request_id,
      start_sec: clamped_target_sec,
      max_duration_sec: Some(max_duration_sec),
      is_full_decode: false,
    })
  }

  fn maybe_prepare_followup_segment_decode_request(
    &mut self,
    deck: DeckId,
  ) -> Option<DecodeRequest> {
    let deck_state = self.deck(deck);
    let playing = deck_state.playing;
    let pending_decode = deck_state.pending_decode_file_path.is_some();
    let pcm_ready =
      !deck_state.pcm_data.is_empty() && deck_state.sample_rate > 0 && deck_state.channels > 0;
    let current_sec = deck_state.current_sec.max(0.0);
    let duration_sec = deck_state.duration_sec.max(0.0);
    if !playing {
      return None;
    }
    if pending_decode {
      return None;
    }
    if !pcm_ready {
      return self.prepare_segment_decode_request(
        deck,
        current_sec,
        HORIZONTAL_BROWSE_ASYNC_SEGMENT_DECODE_SEC,
        false,
      );
    }
    let loaded_end_sec = self.resolve_loaded_segment_end_sec(deck);
    if loaded_end_sec >= duration_sec - 0.0001 {
      return None;
    }
    if current_sec < loaded_end_sec - HORIZONTAL_BROWSE_SEGMENT_PREFETCH_THRESHOLD_SEC {
      return None;
    }
    let next_start_sec = (loaded_end_sec - HORIZONTAL_BROWSE_SEGMENT_PREFETCH_OVERLAP_SEC)
      .max(current_sec)
      .min(duration_sec);
    self.prepare_segment_decode_request(
      deck,
      next_start_sec,
      HORIZONTAL_BROWSE_ASYNC_SEGMENT_DECODE_SEC,
      true,
    )
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

  fn capture_decode_merge_baseline(
    &self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) -> Option<DecodeMergeBaseline> {
    if !self.request_matches(deck, file_path, request_id, fully_decoded) {
      return None;
    }
    let deck_state = self.deck(deck);
    Some(DecodeMergeBaseline {
      pcm_data: Arc::clone(&deck_state.pcm_data),
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
    } else {
      target.pending_decode_file_path = None;
    }
    if should_reset_master_tempo {
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
    }
    true
  }

  fn mark_decode_finished(&mut self, deck: DeckId, file_path: &str, request_id: u64) {
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
    if full_decode_request_id == request_id {
      target.pending_full_decode_file_path = None;
    } else {
      target.pending_decode_file_path = None;
    }
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
    let target = self.deck_mut(deck);
    horizontal_browse_transport_audio::sample_deck(target, output_sample_rate)
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

  fn original_beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
    let deck_state = self.deck(deck);
    let bpm = deck_state.bpm?;
    if !bpm.is_finite() || bpm <= 0.0 {
      return None;
    }
    Some(BeatGridSnapshot {
      bpm,
      beat_sec: 60.0 / bpm,
      first_beat_sec: (deck_state.first_beat_ms.unwrap_or(0.0).max(0.0)) / 1000.0,
    })
  }

  fn beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
    let original = self.original_beat_grid(deck)?;
    let multiplier = self.bpm_multiplier[Self::deck_index(deck)];
    let adjusted_bpm = original.bpm
      * if multiplier.is_finite() && multiplier > 0.0 {
        multiplier
      } else {
        1.0
      };
    if !adjusted_bpm.is_finite() || adjusted_bpm <= 0.0 {
      return None;
    }
    Some(BeatGridSnapshot {
      bpm: adjusted_bpm,
      beat_sec: 60.0 / adjusted_bpm,
      first_beat_sec: original.first_beat_sec,
    })
  }

  fn effective_bpm_for_deck(&self, deck: DeckId) -> f64 {
    let Some(grid) = self.beat_grid(deck) else {
      return 0.0;
    };
    let playback_rate = self.deck(deck).playback_rate;
    grid.bpm
      * if playback_rate.is_finite() && playback_rate > 0.0 {
        playback_rate
      } else {
        1.0
      }
  }

  fn estimate_current_sec(deck: &DeckState, now_ms: f64) -> f64 {
    let base = if deck.current_sec.is_finite() {
      deck.current_sec.max(0.0)
    } else {
      0.0
    };
    if deck.pcm_data.is_empty() || deck.sample_rate == 0 || deck.channels == 0 {
      return base;
    }
    if !deck.playing {
      return base;
    }
    if deck.last_observed_at_ms < 0.0 {
      return base;
    }
    if !deck.last_observed_at_ms.is_finite() || deck.last_observed_at_ms <= 0.0 {
      return base;
    }
    let rate = if deck.playback_rate.is_finite() && deck.playback_rate > 0.0 {
      deck.playback_rate
    } else {
      1.0
    };
    let delta_sec = ((now_ms - deck.last_observed_at_ms).max(0.0)) / 1000.0;
    let estimated = base + delta_sec * rate;
    if deck.duration_sec.is_finite() && deck.duration_sec > 0.0 {
      estimated.clamp(0.0, deck.duration_sec)
    } else {
      estimated.max(0.0)
    }
  }

  fn resolve_leader_candidate(&self, requested: DeckId) -> Option<DeckId> {
    if let Some(leader) = self.leader {
      if self.is_loaded(leader) {
        return Some(leader);
      }
    }
    let other = requested.other();
    if self.deck(other).playing {
      return Some(other);
    }
    if self.is_loaded(other) {
      return Some(other);
    }
    if self.is_loaded(requested) {
      return Some(requested);
    }
    None
  }

  fn resolve_bpm_multiplier(&self, deck: DeckId, master_effective_bpm: f64) -> f64 {
    let Some(grid) = self.original_beat_grid(deck) else {
      return 1.0;
    };
    let candidates = [0.5_f64, 1.0, 2.0];
    let mut best = 1.0;
    let mut best_diff = f64::INFINITY;
    for candidate in candidates {
      let adjusted = grid.bpm * candidate;
      if !adjusted.is_finite() || adjusted <= 0.0 {
        continue;
      }
      let diff = (master_effective_bpm / adjusted).ln().abs();
      if diff < best_diff {
        best = candidate;
        best_diff = diff;
      }
    }
    best
  }

  fn update_multipliers(&mut self) {
    let Some(leader) = self.leader else {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    };
    if self.original_beat_grid(leader).is_none() {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    }
    let leader_effective_bpm = self.effective_bpm_for_deck(leader);
    if !leader_effective_bpm.is_finite() || leader_effective_bpm <= 0.0 {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    }
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      self.bpm_multiplier[index] = if deck == leader {
        1.0
      } else {
        self.resolve_bpm_multiplier(deck, leader_effective_bpm)
      };
    }
  }

  fn derive_state(&self, deck: DeckId, now_ms: f64) -> DeckDerivedState {
    let deck_state = self.deck(deck);
    let current_sec = Self::estimate_current_sec(deck_state, now_ms);
    if self.beat_grid(deck).is_none() {
      return DeckDerivedState {
        estimated_current_sec: current_sec,
        effective_bpm: 0.0,
        render_current_sec: current_sec,
      };
    }
    DeckDerivedState {
      estimated_current_sec: current_sec,
      effective_bpm: self.effective_bpm_for_deck(deck),
      render_current_sec: current_sec,
    }
  }

  fn recompute_distances(&mut self) {
    let now_ms = self.last_now_ms;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      let Some(grid) = self.beat_grid(deck) else {
        self.beat_distance[index] = 0.0;
        self.target_beat_distance[index] = 0.0;
        continue;
      };
      let current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
      self.beat_distance[index] = (current_sec - grid.first_beat_sec) / grid.beat_sec;
      self.target_beat_distance[index] = self.beat_distance[index];
    }
    if let Some(leader) = self.leader {
      let leader_index = Self::deck_index(leader);
      let leader_target = self.beat_distance[leader_index];
      for deck in [DeckId::Top, DeckId::Bottom] {
        let index = Self::deck_index(deck);
        self.target_beat_distance[index] = if deck == leader {
          self.beat_distance[index]
        } else {
          leader_target
        };
      }
    }
  }

  fn target_sec_from_beat_distance(grid: BeatGridSnapshot, beat_distance: f64) -> f64 {
    grid.first_beat_sec + beat_distance * grid.beat_sec
  }

  fn nearest_valid_beat_distance_with_phase(
    current_beat_distance: f64,
    leader_beat_distance: f64,
    min_beat_distance: f64,
    max_beat_distance: f64,
  ) -> f64 {
    let leader_phase = leader_beat_distance.rem_euclid(1.0);
    let min_index = (min_beat_distance - leader_phase).ceil();
    let max_index = (max_beat_distance - leader_phase).floor();
    if min_index > max_index {
      return current_beat_distance.clamp(min_beat_distance, max_beat_distance);
    }
    let snapped_index = (current_beat_distance - leader_phase)
      .round()
      .clamp(min_index, max_index);
    leader_phase + snapped_index
  }

  fn snapshot(&self, now_ms: f64) -> HorizontalBrowseTransportSnapshot {
    let top = self.deck_snapshot(DeckId::Top, now_ms);
    let bottom = self.deck_snapshot(DeckId::Bottom, now_ms);
    HorizontalBrowseTransportSnapshot {
      leader_deck: self.leader.map(|deck| deck.as_str().to_string()),
      top,
      bottom,
    }
  }

  fn deck_snapshot(&self, deck: DeckId, now_ms: f64) -> HorizontalBrowseTransportDeckSnapshot {
    let deck_state = self.deck(deck);
    let derived = self.derive_state(deck, now_ms);
    HorizontalBrowseTransportDeckSnapshot {
      deck: deck.as_str().to_string(),
      label: deck_state
        .title
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
          deck_state
            .file_path
            .as_ref()
            .and_then(|path| path.split(['/', '\\']).last().map(|s| s.to_string()))
            .unwrap_or_default()
        }),
      loaded: self.is_loaded(deck),
      decoding: deck_state.pending_decode_file_path.is_some()
        || deck_state.pending_full_decode_file_path.is_some(),
      playing: deck_state.playing,
      current_sec: derived.estimated_current_sec,
      duration_sec: deck_state.duration_sec,
      playback_rate: deck_state.playback_rate,
      master_tempo_enabled: deck_state.master_tempo_enabled,
      bpm: deck_state.bpm.unwrap_or(0.0),
      effective_bpm: derived.effective_bpm,
      render_current_sec: derived.render_current_sec,
      sync_enabled: self.sync_enabled[Self::deck_index(deck)],
      sync_lock: self.sync_lock[Self::deck_index(deck)].to_string(),
      leader: self.leader == Some(deck),
    }
  }

  fn refresh(&mut self) {
    self.auto_select_leader_from_playback();
    self.update_multipliers();
    self.recompute_distances();
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      if !self.sync_enabled[index] {
        self.set_sync_lock(deck, "off");
        continue;
      }
      if self.leader.is_none() {
        self.set_sync_lock(deck, "off");
        continue;
      }
      if self.leader == Some(deck) {
        self.set_sync_lock(deck, "full");
        continue;
      }
      if self.sync_lock[index] == "off" {
        self.set_sync_lock(deck, "full");
      }
    }
    if let Some(leader) = self.leader {
      let now_ms = self.last_now_ms;
      let Some(leader_grid) = self.beat_grid(leader) else {
        return;
      };
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let leader_target_beat_distance =
        (leader_current_sec - leader_grid.first_beat_sec) / leader_grid.beat_sec;
      for deck in [DeckId::Top, DeckId::Bottom] {
        if deck == leader {
          continue;
        }
        let deck_index = Self::deck_index(deck);
        if !self.sync_enabled[deck_index] || self.sync_lock[deck_index] == "off" {
          continue;
        }
        let Some(target_grid) = self.beat_grid(deck) else {
          continue;
        };
        let target_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
        let target_beat_distance =
          (target_current_sec - target_grid.first_beat_sec) / target_grid.beat_sec;
        self.target_beat_distance[deck_index] = leader_target_beat_distance;

        let leader_effective_bpm = self.effective_bpm_for_deck(leader);
        if let Some(tempo_rate) = {
          let multiplier = self.resolve_bpm_multiplier(deck, leader_effective_bpm);
          self.bpm_multiplier[deck_index] = multiplier;
          self.original_beat_grid(deck).and_then(|grid| {
            let adjusted_target_bpm = grid.bpm
              * if multiplier.is_finite() && multiplier > 0.0 {
                multiplier
              } else {
                1.0
              };
            if adjusted_target_bpm.is_finite() && adjusted_target_bpm > 0.0 {
              Some((leader_effective_bpm / adjusted_target_bpm).clamp(0.25, 4.0))
            } else {
              None
            }
          })
        } {
          self.deck_mut(deck).playback_rate = tempo_rate;
        }

        if self.sync_lock[deck_index] == "full"
          && self.quantize_enabled[deck_index]
          && self.deck(deck).playing
        {
          let target_phase = ((target_beat_distance % 1.0) + 1.0) % 1.0 * target_grid.beat_sec;
          let leader_phase =
            ((leader_target_beat_distance % 1.0) + 1.0) % 1.0 * target_grid.beat_sec;
          let mut phase_offset = target_phase - leader_phase;
          if phase_offset > target_grid.beat_sec / 2.0 {
            phase_offset -= target_grid.beat_sec;
          }
          if phase_offset < -target_grid.beat_sec / 2.0 {
            phase_offset += target_grid.beat_sec;
          }
          let target = self.deck_mut(deck);
          target.current_sec =
            (target_current_sec - phase_offset).clamp(0.0, target.duration_sec.max(0.0));
          target.last_observed_at_ms = now_ms;
        }
      }
      self.recompute_distances();
    }
  }

  fn sync_deck_to_now(&mut self, deck: DeckId, now_ms: f64) {
    let estimated = Self::estimate_current_sec(self.deck(deck), now_ms);
    let target = self.deck_mut(deck);
    target.current_sec = estimated;
    target.last_observed_at_ms = now_ms;
  }

  fn set_leader(&mut self, deck: Option<DeckId>) {
    self.leader = deck.filter(|candidate| self.is_loaded(*candidate));
    self.refresh();
  }

  fn set_playing(&mut self, deck: DeckId, now_ms: f64, playing: bool) -> Option<DecodeRequest> {
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let current_sec = {
      let target = self.deck_mut(deck);
      target.playing = playing;
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
      target.current_sec
    };
    let decode_request = if playing {
      self.prepare_segment_decode_request(
        deck,
        current_sec,
        HORIZONTAL_BROWSE_IMMEDIATE_PLAY_SEGMENT_DECODE_SEC,
        false,
      )
    } else {
      None
    };
    self.refresh();
    decode_request
  }

  fn seek(&mut self, deck: DeckId, now_ms: f64, current_sec: f64) -> Option<DecodeRequest> {
    self.last_now_ms = now_ms;
    let seek_sec = {
      let target = self.deck_mut(deck);
      target.current_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
        current_sec.clamp(0.0, target.duration_sec)
      } else {
        current_sec.max(0.0)
      };
      target.last_observed_at_ms = now_ms;
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
      target.current_sec
    };
    let decode_request = self.prepare_segment_decode_request(
      deck,
      seek_sec,
      HORIZONTAL_BROWSE_SYNC_SEGMENT_DECODE_SEC,
      false,
    );
    self.refresh();
    decode_request
  }

  fn set_sync_enabled(&mut self, deck: DeckId, enabled: bool) {
    let index = Self::deck_index(deck);
    self.sync_enabled[index] = enabled;
    if !enabled {
      self.set_sync_lock(deck, "off");
      self.refresh();
      return;
    }
    let leader = self.resolve_leader_candidate(deck);
    if self.leader != leader {
      self.leader = leader;
    }
    self.refresh();
  }

  fn beatsync(&mut self, deck: DeckId) {
    let Some(leader) = self.resolve_leader_candidate(deck) else {
      return;
    };
    if leader == deck {
      self.leader = Some(deck);
      self.refresh();
      return;
    }
    self.leader = Some(leader);
    self.sync_enabled[Self::deck_index(deck)] = true;
    self.set_sync_lock(deck, "full");
    let now_ms = self.last_now_ms;
    let leader_index = Self::deck_index(leader);
    let deck_index = Self::deck_index(deck);
    self.bpm_multiplier[leader_index] = 1.0;
    let leader_effective_bpm = self.effective_bpm_for_deck(leader);
    self.bpm_multiplier[deck_index] = self.resolve_bpm_multiplier(deck, leader_effective_bpm);
    if let (Some(leader_grid), Some(target_grid)) = (self.beat_grid(leader), self.beat_grid(deck)) {
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let leader_beat_distance =
        (leader_current_sec - leader_grid.first_beat_sec) / leader_grid.beat_sec;
      let target_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
      let target_current_beat_distance =
        (target_current_sec - target_grid.first_beat_sec) / target_grid.beat_sec;
      let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
      let min_target_beat_distance = (0.0 - target_grid.first_beat_sec) / target_grid.beat_sec;
      let max_target_beat_distance =
        (target_duration_sec - target_grid.first_beat_sec) / target_grid.beat_sec;
      let snapped_target_beat_distance = Self::nearest_valid_beat_distance_with_phase(
        target_current_beat_distance,
        leader_beat_distance,
        min_target_beat_distance,
        max_target_beat_distance,
      );
      let target_sec =
        Self::target_sec_from_beat_distance(target_grid, snapped_target_beat_distance);
      let target = self.deck_mut(deck);
      target.current_sec = target_sec.clamp(0.0, target.duration_sec.max(0.0));
      target.last_observed_at_ms = now_ms;
      self.deck_mut(deck).playback_rate = (leader_effective_bpm / target_grid.bpm).clamp(0.25, 4.0);
      let target = self.deck_mut(deck);
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
    }
    self.refresh();
  }
}

fn merge_partial_pcm_segment(
  existing_pcm_data: &[f32],
  existing_start_sec: f64,
  existing_sample_rate: u32,
  existing_channels: u16,
  samples: &[f32],
  sample_rate: u32,
  channels: u16,
  start_sec: f64,
) -> Option<(Vec<f32>, f64)> {
  if samples.is_empty()
    || sample_rate == 0
    || channels == 0
    || existing_pcm_data.is_empty()
    || existing_sample_rate != sample_rate
    || existing_channels != channels
  {
    return None;
  }

  let channel_count = channels as usize;
  let old_frame_count = existing_pcm_data.len() / channel_count;
  let new_frame_count = samples.len() / channel_count;
  if old_frame_count == 0 || new_frame_count == 0 {
    return None;
  }

  let old_start_frame = (existing_start_sec.max(0.0) * sample_rate as f64).round() as i64;
  let new_start_frame = (start_sec.max(0.0) * sample_rate as f64).round() as i64;
  let old_end_frame = old_start_frame + old_frame_count as i64;
  let new_end_frame = new_start_frame + new_frame_count as i64;
  if new_start_frame > old_end_frame + 1 || new_end_frame + 1 < old_start_frame {
    return None;
  }

  let merged_start_frame = old_start_frame.min(new_start_frame);
  let merged_end_frame = old_end_frame.max(new_end_frame);
  let merged_frames = (merged_end_frame - merged_start_frame).max(0) as usize;
  let mut merged = vec![0.0; merged_frames * channel_count];
  let old_start_sample = (old_start_frame - merged_start_frame).max(0) as usize * channel_count;
  let old_end_sample = old_start_sample + existing_pcm_data.len();
  merged[old_start_sample..old_end_sample].copy_from_slice(existing_pcm_data);

  let new_start_offset_frames = (new_start_frame - merged_start_frame).max(0) as usize;
  let unique_prefix_frames = if new_start_frame < old_start_frame {
    (old_start_frame - new_start_frame).min(new_frame_count as i64) as usize
  } else {
    0
  };
  if unique_prefix_frames > 0 {
    let prefix_sample_count = unique_prefix_frames * channel_count;
    merged[..prefix_sample_count].copy_from_slice(&samples[..prefix_sample_count]);
  }

  let unique_suffix_start_frame = if new_end_frame > old_end_frame {
    (old_end_frame - new_start_frame)
      .max(0)
      .min(new_frame_count as i64) as usize
  } else {
    new_frame_count
  };
  if unique_suffix_start_frame < new_frame_count {
    let source_start = unique_suffix_start_frame * channel_count;
    let target_start = (new_start_offset_frames + unique_suffix_start_frame) * channel_count;
    let source_end = samples.len();
    let target_end = target_start + (source_end - source_start);
    merged[target_start..target_end].copy_from_slice(&samples[source_start..source_end]);
  }

  Some((merged, merged_start_frame as f64 / sample_rate as f64))
}

fn prepare_decoded_audio(
  baseline: Option<DecodeMergeBaseline>,
  samples: Vec<f32>,
  sample_rate: u32,
  channels: u16,
  start_sec: f64,
  fully_decoded: bool,
) -> PreparedDecodedAudio {
  if fully_decoded {
    return PreparedDecodedAudio {
      pcm_data: Arc::new(samples),
      pcm_start_sec: 0.0,
      sample_rate,
      channels,
      preserve_master_tempo_state: false,
    };
  }

  if let Some(existing) = baseline {
    if let Some((merged_pcm_data, merged_start_sec)) = merge_partial_pcm_segment(
      existing.pcm_data.as_ref().as_slice(),
      existing.pcm_start_sec,
      existing.sample_rate,
      existing.channels,
      &samples,
      sample_rate,
      channels,
      start_sec,
    ) {
      let preserve_master_tempo_state = existing.sample_rate == sample_rate
        && existing.channels == channels
        && (merged_start_sec - existing.pcm_start_sec).abs() <= 0.0001;
      return PreparedDecodedAudio {
        pcm_data: Arc::new(merged_pcm_data),
        pcm_start_sec: merged_start_sec,
        sample_rate,
        channels,
        preserve_master_tempo_state,
      };
    }
  }

  PreparedDecodedAudio {
    pcm_data: Arc::new(samples),
    pcm_start_sec: start_sec.max(0.0),
    sample_rate,
    channels,
    preserve_master_tempo_state: false,
  }
}

fn finish_decode_request(request: DecodeRequest, decoded: Option<(Vec<f32>, u32, u16)>) {
  match decoded {
    Some((samples, sample_rate, channels)) => {
      let merge_baseline = {
        let engine_guard = engine().lock();
        engine_guard.capture_decode_merge_baseline(
          request.deck,
          &request.file_path,
          request.request_id,
          request.is_full_decode,
        )
      };
      let Some(merge_baseline) = merge_baseline else {
        return;
      };
      let prepared = prepare_decoded_audio(
        Some(merge_baseline),
        samples,
        sample_rate,
        channels,
        request.start_sec,
        request.is_full_decode,
      );
      let mut engine_guard = engine().lock();
      if engine_guard.apply_prepared_decoded_audio(
        request.deck,
        &request.file_path,
        request.request_id,
        prepared,
        request.is_full_decode,
      ) {
        engine_guard.refresh();
      }
    }
    None => {
      let mut engine_guard = engine().lock();
      engine_guard.mark_decode_finished(request.deck, &request.file_path, request.request_id);
      engine_guard.refresh();
    }
  }
}

fn decode_transport_audio_file(file_path: &str) -> Option<(Vec<f32>, u32, u16)> {
  let result = crate::decode_audio_file(file_path.to_string());
  if result.error.is_some() {
    return None;
  }
  let pcm_bytes = result.pcm_data.as_ref();
  if pcm_bytes.len() % 4 != 0 {
    return None;
  }
  let mut samples = Vec::with_capacity(pcm_bytes.len() / 4);
  for chunk in pcm_bytes.chunks_exact(4) {
    samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
  }
  Some((samples, result.sample_rate, result.channels as u16))
}

fn decode_transport_audio_file_head(
  file_path: &str,
  start_sec: f64,
  max_duration_sec: Option<f64>,
) -> Option<(Vec<f32>, u32, u16)> {
  let path = std::path::Path::new(file_path);
  let ffmpeg_pcm = crate::ffmpeg_decode_to_i16_with_window(
    path,
    Some(start_sec.max(0.0)),
    Some(
      max_duration_sec
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(HORIZONTAL_BROWSE_ASYNC_SEGMENT_DECODE_SEC),
    ),
  )
  .ok()?;
  if ffmpeg_pcm.channels == 0 {
    return None;
  }
  let samples = ffmpeg_pcm
    .samples_i16
    .iter()
    .map(|sample| (*sample as f32) / 32768.0)
    .collect::<Vec<f32>>();
  Some((samples, ffmpeg_pcm.sample_rate, ffmpeg_pcm.channels))
}

fn schedule_decode_request(request: DecodeRequest) {
  thread::spawn(move || {
    let decoded = if request.is_full_decode {
      decode_transport_audio_file(&request.file_path)
    } else {
      decode_transport_audio_file_head(
        &request.file_path,
        request.start_sec,
        request.max_duration_sec,
      )
    };
    finish_decode_request(request, decoded);
  });
}

fn execute_decode_request_sync(request: DecodeRequest) {
  let decoded = if request.is_full_decode {
    decode_transport_audio_file(&request.file_path)
  } else {
    decode_transport_audio_file_head(
      &request.file_path,
      request.start_sec,
      request.max_duration_sec,
    )
  };
  finish_decode_request(request, decoded);
}

static HORIZONTAL_BROWSE_TRANSPORT: OnceLock<Mutex<HorizontalBrowseTransportEngine>> =
  OnceLock::new();
static OUTPUT_THREAD_STARTED: OnceLock<()> = OnceLock::new();
static PREFETCH_THREAD_STARTED: OnceLock<()> = OnceLock::new();

fn engine() -> &'static Mutex<HorizontalBrowseTransportEngine> {
  HORIZONTAL_BROWSE_TRANSPORT.get_or_init(|| Mutex::new(HorizontalBrowseTransportEngine::default()))
}

fn ensure_prefetch_worker() {
  if PREFETCH_THREAD_STARTED.get().is_some() {
    return;
  }
  let _ = PREFETCH_THREAD_STARTED.set(());
  thread::spawn(|| loop {
    let requests = {
      let mut engine_guard = engine().lock();
      let mut pending = Vec::new();
      for deck in [DeckId::Top, DeckId::Bottom] {
        if let Some(request) = engine_guard.maybe_prepare_followup_segment_decode_request(deck) {
          pending.push(request);
        }
      }
      pending
    };
    for request in requests {
      schedule_decode_request(request);
    }
    thread::sleep(Duration::from_millis(200));
  });
}

#[napi]
pub fn horizontal_browse_transport_reset() {
  *engine().lock() = HorizontalBrowseTransportEngine::default();
}

#[napi]
pub fn horizontal_browse_transport_set_deck_state(
  deck: String,
  now_ms: Option<f64>,
  payload: HorizontalBrowseTransportDeckInput,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let deck_playing = payload.playing;
  let mut engine_guard = engine().lock();
  engine_guard.last_now_ms = now_ms.unwrap_or(payload.last_observed_at_ms);
  {
    let target = engine_guard.deck_mut(deck_id);
    target.file_path = payload.file_path;
    target.title = payload.title;
    target.bpm = payload.bpm;
    target.first_beat_ms = payload.first_beat_ms;
    target.duration_sec = payload.duration_sec;
    target.current_sec = payload.current_sec;
    target.last_observed_at_ms = payload.last_observed_at_ms;
    target.playing = payload.playing;
    target.playback_rate = payload.playback_rate;
    target.master_tempo_enabled = payload.master_tempo_enabled;
    horizontal_browse_transport_audio::reset_master_tempo_state(target);
  }
  let decode_request = engine_guard.prepare_decode_request(deck_id);
  ensure_prefetch_worker();
  let _ = engine_guard.ensure_output_stream();
  engine_guard.refresh();
  drop(engine_guard);
  if let Some(request) = decode_request {
    if deck_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  let engine_guard = engine().lock();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_state(
  payload: HorizontalBrowseTransportStateInput,
) -> HorizontalBrowseTransportSnapshot {
  let top_playing = payload.top.playing;
  let bottom_playing = payload.bottom.playing;
  let now_ms = payload.now_ms.unwrap_or(
    payload
      .top
      .last_observed_at_ms
      .max(payload.bottom.last_observed_at_ms),
  );
  let mut engine_guard = engine().lock();
  engine_guard.last_now_ms = now_ms;
  {
    let top = engine_guard.deck_mut(DeckId::Top);
    top.file_path = payload.top.file_path;
    top.title = payload.top.title;
    top.bpm = payload.top.bpm;
    top.first_beat_ms = payload.top.first_beat_ms;
    top.duration_sec = payload.top.duration_sec;
    top.current_sec = payload.top.current_sec;
    top.last_observed_at_ms = payload.top.last_observed_at_ms;
    top.playing = payload.top.playing;
    top.playback_rate = payload.top.playback_rate;
    top.master_tempo_enabled = payload.top.master_tempo_enabled;
    horizontal_browse_transport_audio::reset_master_tempo_state(top);
  }
  {
    let bottom = engine_guard.deck_mut(DeckId::Bottom);
    bottom.file_path = payload.bottom.file_path;
    bottom.title = payload.bottom.title;
    bottom.bpm = payload.bottom.bpm;
    bottom.first_beat_ms = payload.bottom.first_beat_ms;
    bottom.duration_sec = payload.bottom.duration_sec;
    bottom.current_sec = payload.bottom.current_sec;
    bottom.last_observed_at_ms = payload.bottom.last_observed_at_ms;
    bottom.playing = payload.bottom.playing;
    bottom.playback_rate = payload.bottom.playback_rate;
    bottom.master_tempo_enabled = payload.bottom.master_tempo_enabled;
    horizontal_browse_transport_audio::reset_master_tempo_state(bottom);
  }
  let top_decode_request = engine_guard.prepare_decode_request(DeckId::Top);
  let bottom_decode_request = engine_guard.prepare_decode_request(DeckId::Bottom);
  ensure_prefetch_worker();
  let _ = engine_guard.ensure_output_stream();
  engine_guard.refresh();
  drop(engine_guard);
  if let Some(request) = top_decode_request {
    if top_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  if let Some(request) = bottom_decode_request {
    if bottom_playing {
      execute_decode_request_sync(request);
    } else {
      schedule_decode_request(request);
    }
  }
  let engine_guard = engine().lock();
  engine_guard.snapshot(engine_guard.last_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_set_sync_enabled(
  deck: String,
  now_ms: Option<f64>,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.last_now_ms = now_ms.unwrap_or(engine.last_now_ms);
  engine.set_sync_enabled(deck_id, enabled);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_beatsync(
  deck: String,
  now_ms: Option<f64>,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.last_now_ms = now_ms.unwrap_or(engine.last_now_ms);
  engine.beatsync(deck_id);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_leader(
  deck: Option<String>,
  now_ms: Option<f64>,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let next_leader = match deck {
    Some(value) => Some(parse_deck_id(&value)?),
    None => None,
  };
  let mut engine = engine().lock();
  engine.last_now_ms = now_ms.unwrap_or(engine.last_now_ms);
  engine.set_leader(next_leader);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_playing(
  deck: String,
  now_ms: f64,
  playing: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  ensure_prefetch_worker();
  let _ = engine_guard.ensure_output_stream();
  let decode_request = engine_guard.set_playing(deck_id, now_ms, playing);
  drop(engine_guard);
  if let Some(request) = decode_request {
    execute_decode_request_sync(request);
  }
  let engine_guard = engine().lock();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_seek(
  deck: String,
  now_ms: f64,
  current_sec: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  let decode_request = engine_guard.seek(deck_id, now_ms, current_sec);
  drop(engine_guard);
  if let Some(request) = decode_request {
    execute_decode_request_sync(request);
  }
  let engine_guard = engine().lock();
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_gain(
  deck: String,
  gain: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  let target = engine.deck_mut(deck_id);
  target.gain = if gain.is_finite() {
    gain.clamp(0.0, 1.0) as f32
  } else {
    1.0
  };
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_snapshot(
  now_ms: Option<f64>,
) -> HorizontalBrowseTransportSnapshot {
  let engine = engine().lock();
  engine.snapshot(now_ms.unwrap_or_else(performance_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_visualizer_snapshot(
) -> HorizontalBrowseTransportVisualizerSnapshot {
  let engine = engine().lock();
  engine.visualizer_snapshot()
}

fn performance_now_ms() -> f64 {
  #[cfg(target_arch = "wasm32")]
  {
    0.0
  }
  #[cfg(not(target_arch = "wasm32"))]
  {
    let now = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default();
    now.as_secs_f64() * 1000.0
  }
}

#[cfg(test)]
#[path = "horizontal_browse_transport_tests.rs"]
mod horizontal_browse_transport_tests;
