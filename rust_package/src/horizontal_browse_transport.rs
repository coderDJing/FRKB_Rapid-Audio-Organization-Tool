use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::*;
use parking_lot::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeckId {
  Top,
  Bottom,
}

impl DeckId {
  fn as_str(self) -> &'static str {
    match self {
      DeckId::Top => "top",
      DeckId::Bottom => "bottom",
    }
  }

  fn other(self) -> Self {
    match self {
      DeckId::Top => DeckId::Bottom,
      DeckId::Bottom => DeckId::Top,
    }
  }
}

fn parse_deck_id(raw: &str) -> napi::Result<DeckId> {
  match raw.trim().to_lowercase().as_str() {
    "top" => Ok(DeckId::Top),
    "bottom" => Ok(DeckId::Bottom),
    _ => Err(Error::from_reason(format!("unknown deck id: {}", raw))),
  }
}

#[napi(object)]
pub struct HorizontalBrowseTransportDeckInput {
  pub file_path: Option<String>,
  pub title: Option<String>,
  pub bpm: Option<f64>,
  pub first_beat_ms: Option<f64>,
  pub duration_sec: f64,
  pub current_sec: f64,
  pub last_observed_at_ms: f64,
  pub playing: bool,
  pub playback_rate: f64,
}

#[napi(object)]
pub struct HorizontalBrowseTransportStateInput {
  pub now_ms: Option<f64>,
  pub top: HorizontalBrowseTransportDeckInput,
  pub bottom: HorizontalBrowseTransportDeckInput,
}

#[napi(object)]
pub struct HorizontalBrowseTransportDeckSnapshot {
  pub deck: String,
  pub label: String,
  pub playing: bool,
  pub current_sec: f64,
  pub duration_sec: f64,
  pub playback_rate: f64,
  pub bpm: f64,
  pub effective_bpm: f64,
  pub render_current_sec: f64,
  pub sync_enabled: bool,
  pub sync_lock: String,
  pub leader: bool,
}

#[napi(object)]
pub struct HorizontalBrowseTransportSnapshot {
  pub leader_deck: Option<String>,
  pub top: HorizontalBrowseTransportDeckSnapshot,
  pub bottom: HorizontalBrowseTransportDeckSnapshot,
}

#[derive(Clone, Default)]
struct DeckState {
  file_path: Option<String>,
  loaded_file_path: Option<String>,
  title: Option<String>,
  bpm: Option<f64>,
  first_beat_ms: Option<f64>,
  duration_sec: f64,
  current_sec: f64,
  last_observed_at_ms: f64,
  playing: bool,
  playback_rate: f64,
  pcm_data: Vec<f32>,
  sample_rate: u32,
  channels: u16,
  gain: f32,
}

#[derive(Clone, Copy)]
struct BeatGridSnapshot {
  bpm: f64,
  beat_sec: f64,
  first_beat_sec: f64,
}

#[derive(Clone, Copy)]
struct DeckDerivedState {
  estimated_current_sec: f64,
  effective_bpm: f64,
  render_current_sec: f64,
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
    }
  }
}

impl HorizontalBrowseTransportEngine {
  fn prepare_decode_request(&mut self, deck: DeckId) -> Option<String> {
    let file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim().to_string())
      .unwrap_or_default();
    if file_path.is_empty() {
      let target = self.deck_mut(deck);
      target.loaded_file_path = None;
      target.pcm_data.clear();
      target.sample_rate = 0;
      target.channels = 0;
      return None;
    }
    if self.deck(deck).loaded_file_path.as_deref() == Some(file_path.as_str())
      && !self.deck(deck).pcm_data.is_empty()
      && self.deck(deck).sample_rate > 0
      && self.deck(deck).channels > 0
    {
      return None;
    }
    let target = self.deck_mut(deck);
    target.loaded_file_path = None;
    target.pcm_data.clear();
    target.sample_rate = 0;
    target.channels = 0;
    Some(file_path)
  }

  fn apply_decoded_audio(
    &mut self,
    deck: DeckId,
    file_path: &str,
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
  ) {
    let current_file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    if current_file_path != file_path {
      return;
    }
    let target = self.deck_mut(deck);
    target.loaded_file_path = Some(file_path.to_string());
    target.pcm_data = samples;
    target.sample_rate = sample_rate;
    target.channels = channels;
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
    (left.clamp(-1.0, 1.0), right.clamp(-1.0, 1.0))
  }

  fn sample_deck(&mut self, deck: DeckId) -> (f32, f32) {
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let target = self.deck_mut(deck);
    if !target.playing
      || target.pcm_data.is_empty()
      || target.sample_rate == 0
      || target.channels == 0
    {
      return (0.0, 0.0);
    }
    let frame_count = target.pcm_data.len() / target.channels as usize;
    if frame_count == 0 {
      return (0.0, 0.0);
    }
    let source_frame = target.current_sec.max(0.0) * target.sample_rate as f64;
    let base_index = source_frame.floor() as usize;
    if base_index >= frame_count {
      target.playing = false;
      return (0.0, 0.0);
    }
    let frac = (source_frame - base_index as f64) as f32;
    let next_index = (base_index + 1).min(frame_count - 1);
    let channels = target.channels as usize;
    let read_sample = |frame_index: usize, channel: usize, data: &Vec<f32>| -> f32 {
      data
        .get(frame_index * channels + channel.min(channels - 1))
        .copied()
        .unwrap_or(0.0)
    };
    let l0 = read_sample(base_index, 0, &target.pcm_data);
    let l1 = read_sample(next_index, 0, &target.pcm_data);
    let r0 = read_sample(
      base_index,
      if channels > 1 { 1 } else { 0 },
      &target.pcm_data,
    );
    let r1 = read_sample(
      next_index,
      if channels > 1 { 1 } else { 0 },
      &target.pcm_data,
    );
    let left = l0 + (l1 - l0) * frac;
    let right = r0 + (r1 - r0) * frac;

    let rate = if target.playback_rate.is_finite() && target.playback_rate > 0.0 {
      target.playback_rate
    } else {
      1.0
    };
    target.current_sec += rate / output_sample_rate;
    target.last_observed_at_ms = -1.0;
    if target.duration_sec.is_finite() && target.current_sec >= target.duration_sec {
      target.current_sec = target.duration_sec;
      target.playing = false;
    }
    (left * target.gain, right * target.gain)
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
    self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|path| !path.trim().is_empty())
      .unwrap_or(false)
  }

  fn set_sync_lock(&mut self, deck: DeckId, next: &'static str) {
    let index = Self::deck_index(deck);
    self.sync_lock[index] = if self.sync_enabled[index] {
      next
    } else {
      "off"
    };
  }

  fn beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
    let deck_state = self.deck(deck);
    let bpm = deck_state.bpm?;
    if !bpm.is_finite() || bpm <= 0.0 {
      return None;
    }
    let multiplier = self.bpm_multiplier[Self::deck_index(deck)];
    let adjusted_bpm = bpm
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
      first_beat_sec: (deck_state.first_beat_ms.unwrap_or(0.0).max(0.0)) / 1000.0,
    })
  }

  fn estimate_current_sec(deck: &DeckState, now_ms: f64) -> f64 {
    let base = if deck.current_sec.is_finite() {
      deck.current_sec.max(0.0)
    } else {
      0.0
    };
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
    let Some(grid) = self.beat_grid(deck) else {
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
    let Some(leader_grid) = self.beat_grid(leader) else {
      self.bpm_multiplier = [1.0, 1.0];
      return;
    };
    let leader_rate = self.deck(leader).playback_rate;
    let leader_effective_bpm = leader_grid.bpm
      * if leader_rate.is_finite() && leader_rate > 0.0 {
        leader_rate
      } else {
        1.0
      };
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
    let Some(grid) = self.beat_grid(deck) else {
      return DeckDerivedState {
        estimated_current_sec: current_sec,
        effective_bpm: 0.0,
        render_current_sec: current_sec,
      };
    };
    DeckDerivedState {
      estimated_current_sec: current_sec,
      effective_bpm: grid.bpm
        * if deck_state.playback_rate.is_finite() && deck_state.playback_rate > 0.0 {
          deck_state.playback_rate
        } else {
          1.0
        },
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
      playing: deck_state.playing,
      current_sec: derived.estimated_current_sec,
      duration_sec: deck_state.duration_sec,
      playback_rate: deck_state.playback_rate,
      bpm: deck_state.bpm.unwrap_or(0.0),
      effective_bpm: derived.effective_bpm,
      render_current_sec: derived.render_current_sec,
      sync_enabled: self.sync_enabled[Self::deck_index(deck)],
      sync_lock: self.sync_lock[Self::deck_index(deck)].to_string(),
      leader: self.leader == Some(deck),
    }
  }

  fn refresh(&mut self) {
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
        let target_snapshot = self.deck(deck).clone();
        let target_current_sec = Self::estimate_current_sec(&target_snapshot, now_ms);
        let target_beat_distance =
          (target_current_sec - target_grid.first_beat_sec) / target_grid.beat_sec;
        self.target_beat_distance[deck_index] = leader_target_beat_distance;

        let leader_effective_bpm = leader_grid.bpm
          * if self.deck(leader).playback_rate.is_finite() && self.deck(leader).playback_rate > 0.0
          {
            self.deck(leader).playback_rate
          } else {
            1.0
          };
        if let Some(tempo_rate) = {
          let multiplier = self.resolve_bpm_multiplier(deck, leader_effective_bpm);
          self.bpm_multiplier[deck_index] = multiplier;
          self.beat_grid(deck).and_then(|grid| {
            if grid.bpm.is_finite() && grid.bpm > 0.0 {
              Some((leader_effective_bpm / grid.bpm).clamp(0.25, 4.0))
            } else {
              None
            }
          })
        } {
          self.deck_mut(deck).playback_rate = tempo_rate;
        }

        if self.sync_lock[deck_index] == "full" && self.quantize_enabled[deck_index] {
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
    let estimated = {
      let snapshot = self.deck(deck).clone();
      Self::estimate_current_sec(&snapshot, now_ms)
    };
    let target = self.deck_mut(deck);
    target.current_sec = estimated;
    target.last_observed_at_ms = now_ms;
  }

  fn set_leader(&mut self, deck: Option<DeckId>) {
    self.leader = deck.filter(|candidate| self.is_loaded(*candidate));
    self.refresh();
  }

  fn set_playing(&mut self, deck: DeckId, now_ms: f64, playing: bool) {
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let target = self.deck_mut(deck);
    target.playing = playing;
    self.refresh();
  }

  fn seek(&mut self, deck: DeckId, now_ms: f64, current_sec: f64) {
    self.last_now_ms = now_ms;
    let target = self.deck_mut(deck);
    target.current_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
      current_sec.clamp(0.0, target.duration_sec)
    } else {
      current_sec.max(0.0)
    };
    target.last_observed_at_ms = now_ms;
    self.refresh();
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
    if let (Some(leader_grid), Some(target_grid)) = (self.beat_grid(leader), self.beat_grid(deck)) {
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let leader_beat_distance =
        (leader_current_sec - leader_grid.first_beat_sec) / leader_grid.beat_sec;
      let target_sec = Self::target_sec_from_beat_distance(target_grid, leader_beat_distance);
      let target = self.deck_mut(deck);
      target.current_sec = target_sec.clamp(0.0, target.duration_sec.max(0.0));
      target.last_observed_at_ms = now_ms;
      let leader_effective_bpm = leader_grid.bpm
        * if self.deck(leader).playback_rate.is_finite() && self.deck(leader).playback_rate > 0.0 {
          self.deck(leader).playback_rate
        } else {
          1.0
        };
      self.bpm_multiplier[Self::deck_index(deck)] =
        self.resolve_bpm_multiplier(deck, leader_effective_bpm);
      if let Some(adjusted_target_grid) = self.beat_grid(deck) {
        self.deck_mut(deck).playback_rate =
          (leader_effective_bpm / adjusted_target_grid.bpm).clamp(0.25, 4.0);
      }
    }
    self.refresh();
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

static HORIZONTAL_BROWSE_TRANSPORT: OnceLock<Mutex<HorizontalBrowseTransportEngine>> =
  OnceLock::new();
static OUTPUT_THREAD_STARTED: OnceLock<()> = OnceLock::new();

fn engine() -> &'static Mutex<HorizontalBrowseTransportEngine> {
  HORIZONTAL_BROWSE_TRANSPORT.get_or_init(|| Mutex::new(HorizontalBrowseTransportEngine::default()))
}

#[napi]
pub fn horizontal_browse_transport_reset() {
  *engine().lock() = HorizontalBrowseTransportEngine::default();
}

#[napi]
pub fn horizontal_browse_transport_set_state(
  payload: HorizontalBrowseTransportStateInput,
) -> HorizontalBrowseTransportSnapshot {
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
    top.gain = 1.0;
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
    bottom.gain = 1.0;
  }
  let top_decode_request = engine_guard.prepare_decode_request(DeckId::Top);
  let bottom_decode_request = engine_guard.prepare_decode_request(DeckId::Bottom);
  let _ = engine_guard.ensure_output_stream();
  drop(engine_guard);

  if let Some(file_path) = top_decode_request {
    if let Some((samples, sample_rate, channels)) = decode_transport_audio_file(&file_path) {
      let mut engine_guard = engine().lock();
      engine_guard.apply_decoded_audio(DeckId::Top, &file_path, samples, sample_rate, channels);
    }
  }
  if let Some(file_path) = bottom_decode_request {
    if let Some((samples, sample_rate, channels)) = decode_transport_audio_file(&file_path) {
      let mut engine_guard = engine().lock();
      engine_guard.apply_decoded_audio(DeckId::Bottom, &file_path, samples, sample_rate, channels);
    }
  }

  let mut engine_guard = engine().lock();
  engine_guard.refresh();
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
  let mut engine = engine().lock();
  let _ = engine.ensure_output_stream();
  engine.set_playing(deck_id, now_ms, playing);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_seek(
  deck: String,
  now_ms: f64,
  current_sec: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.seek(deck_id, now_ms, current_sec);
  Ok(engine.snapshot(engine.last_now_ms))
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
mod tests {
  use super::*;

  #[test]
  fn beatsync_aligns_to_same_beat_distance() {
    let mut engine = HorizontalBrowseTransportEngine::default();
    engine.last_now_ms = 1000.0;
    {
      let top = engine.deck_mut(DeckId::Top);
      top.file_path = Some("a.mp3".to_string());
      top.title = Some("A".to_string());
      top.bpm = Some(140.0);
      top.first_beat_ms = Some(20.0);
      top.duration_sec = 20.0;
      top.current_sec = 4.0;
      top.last_observed_at_ms = 1000.0;
      top.playing = true;
      top.playback_rate = 1.0;
    }
    {
      let bottom = engine.deck_mut(DeckId::Bottom);
      bottom.file_path = Some("b.mp3".to_string());
      bottom.title = Some("B".to_string());
      bottom.bpm = Some(140.0);
      bottom.first_beat_ms = Some(110.0);
      bottom.duration_sec = 20.0;
      bottom.current_sec = 1.0;
      bottom.last_observed_at_ms = 1000.0;
      bottom.playing = true;
      bottom.playback_rate = 1.0;
    }

    engine.set_leader(Some(DeckId::Top));
    engine.beatsync(DeckId::Bottom);

    let top_distance =
      engine.target_beat_distance[HorizontalBrowseTransportEngine::deck_index(DeckId::Top)];
    let bottom_distance =
      engine.target_beat_distance[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)];
    let snapshot = engine.snapshot(1000.0);
    assert!((top_distance - bottom_distance).abs() < 0.0001);
    assert!(snapshot.bottom.current_sec > 0.0);
    assert!(snapshot.bottom.current_sec < 20.0);
  }

  #[test]
  fn set_state_respects_shared_now_ms() {
    let mut engine = HorizontalBrowseTransportEngine::default();
    engine.last_now_ms = 2000.0;
    {
      let top = engine.deck_mut(DeckId::Top);
      top.file_path = Some("a.mp3".to_string());
      top.bpm = Some(120.0);
      top.first_beat_ms = Some(0.0);
      top.duration_sec = 20.0;
      top.current_sec = 1.0;
      top.last_observed_at_ms = 1000.0;
      top.playing = true;
      top.playback_rate = 2.0;
    }

    let snapshot = engine.snapshot(2000.0);
    assert!((snapshot.top.current_sec - 3.0).abs() < 0.0001);
  }

  #[test]
  fn audio_owned_current_sec_does_not_double_count_elapsed_time() {
    let mut engine = HorizontalBrowseTransportEngine::default();
    engine.last_now_ms = 2000.0;
    {
      let top = engine.deck_mut(DeckId::Top);
      top.file_path = Some("a.mp3".to_string());
      top.bpm = Some(128.0);
      top.first_beat_ms = Some(0.0);
      top.duration_sec = 20.0;
      top.current_sec = 5.0;
      top.last_observed_at_ms = -1.0;
      top.playing = true;
      top.playback_rate = 1.0;
    }

    let snapshot = engine.snapshot(2500.0);
    assert!((snapshot.top.current_sec - 5.0).abs() < 0.0001);
  }

  #[test]
  fn bpm_multiplier_picks_closest_half_double() {
    let mut engine = HorizontalBrowseTransportEngine::default();
    {
      let top = engine.deck_mut(DeckId::Top);
      top.file_path = Some("a.mp3".to_string());
      top.bpm = Some(140.0);
      top.first_beat_ms = Some(0.0);
    }
    {
      let bottom = engine.deck_mut(DeckId::Bottom);
      bottom.file_path = Some("b.mp3".to_string());
      bottom.bpm = Some(70.0);
      bottom.first_beat_ms = Some(0.0);
    }
    engine.leader = Some(DeckId::Top);
    engine.update_multipliers();
    assert!(
      (engine.bpm_multiplier[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)] - 2.0)
        .abs()
        < 0.0001
    );
  }
}
