use super::*;

impl HorizontalBrowseTransportEngine {
  pub(super) fn original_beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
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

  pub(super) fn beat_grid(&self, deck: DeckId) -> Option<BeatGridSnapshot> {
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

  pub(super) fn sync_loop_range_for_deck(&mut self, deck: DeckId) -> bool {
    let start_beat_index = self.deck(deck).loop_start_beat_index;
    let beat_value = self.deck(deck).loop_beat_value;
    let Some(start_beat_index) = start_beat_index else {
      let target = self.deck_mut(deck);
      target.loop_active = false;
      target.loop_start_sec = 0.0;
      target.loop_end_sec = 0.0;
      return false;
    };
    let Some(grid) = self.beat_grid(deck) else {
      let target = self.deck_mut(deck);
      target.loop_active = false;
      target.loop_start_beat_index = None;
      target.loop_start_sec = 0.0;
      target.loop_end_sec = 0.0;
      return false;
    };
    let duration_sec = self.deck(deck).duration_sec.max(0.0);
    let raw_start_sec = grid.first_beat_sec + start_beat_index as f64 * grid.beat_sec;
    let raw_end_sec = raw_start_sec + beat_value.max(0.0) * grid.beat_sec;
    let clamped_start_sec = if raw_end_sec <= 0.0 {
      0.0
    } else {
      raw_start_sec.clamp(0.0, duration_sec)
    };
    let clamped_end_sec = if raw_end_sec <= 0.0 {
      (beat_value.max(0.0) * grid.beat_sec).clamp(0.0, duration_sec)
    } else {
      raw_end_sec.clamp(clamped_start_sec, duration_sec)
    };
    if !clamped_end_sec.is_finite()
      || clamped_end_sec - clamped_start_sec <= HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
    {
      let target = self.deck_mut(deck);
      target.loop_active = false;
      target.loop_start_beat_index = None;
      target.loop_start_sec = 0.0;
      target.loop_end_sec = 0.0;
      return false;
    }
    let target = self.deck_mut(deck);
    target.loop_active = true;
    target.loop_start_sec = clamped_start_sec;
    target.loop_end_sec = clamped_end_sec;
    true
  }

  pub(super) fn deactivate_loop(&mut self, deck: DeckId) {
    let target = self.deck_mut(deck);
    target.loop_active = false;
    target.loop_start_beat_index = None;
    target.loop_start_sec = 0.0;
    target.loop_end_sec = 0.0;
  }

  pub(super) fn activate_loop_from_anchor(&mut self, deck: DeckId, anchor_sec: f64) -> bool {
    let Some(grid) = self.beat_grid(deck) else {
      self.deactivate_loop(deck);
      return false;
    };
    let beats_from_first = (anchor_sec - grid.first_beat_sec) / grid.beat_sec;
    if !beats_from_first.is_finite() {
      self.deactivate_loop(deck);
      return false;
    }
    let start_beat_index =
      (beats_from_first + HORIZONTAL_BROWSE_LOOP_BEAT_INDEX_EPSILON).floor() as i32;
    {
      let target = self.deck_mut(deck);
      target.loop_active = true;
      target.loop_start_beat_index = Some(start_beat_index);
      target.loop_beat_value = if target.loop_beat_value.is_finite() && target.loop_beat_value > 0.0
      {
        target.loop_beat_value
      } else {
        HORIZONTAL_BROWSE_LOOP_DEFAULT_BEAT_VALUE
      };
    }
    self.sync_loop_range_for_deck(deck)
  }

  pub(super) fn resolve_loop_beat_value_index(value: f64) -> usize {
    let exact = HORIZONTAL_BROWSE_LOOP_BEAT_VALUES
      .iter()
      .position(|candidate| (*candidate - value).abs() <= 1e-9);
    if let Some(index) = exact {
      return index;
    }
    HORIZONTAL_BROWSE_LOOP_BEAT_VALUES
      .iter()
      .position(|candidate| *candidate >= value)
      .unwrap_or(HORIZONTAL_BROWSE_LOOP_BEAT_VALUES.len() - 1)
  }

  pub(super) fn step_loop_beats(&mut self, deck: DeckId, direction: i32) {
    let current_value = self.deck(deck).loop_beat_value;
    let current_index = Self::resolve_loop_beat_value_index(current_value);
    let next_index = (current_index as i32 + direction)
      .clamp(0, HORIZONTAL_BROWSE_LOOP_BEAT_VALUES.len() as i32 - 1) as usize;
    let next_beat_value = HORIZONTAL_BROWSE_LOOP_BEAT_VALUES[next_index];
    {
      let target = self.deck_mut(deck);
      target.loop_beat_value = next_beat_value;
      if !target.loop_active {
        return;
      }
    }
    if !self.sync_loop_range_for_deck(deck) {
      self.deactivate_loop(deck);
      return;
    }
    if self.deck(deck).playing {
      let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
      let loop_start_sec = self.deck(deck).loop_start_sec;
      let loop_end_sec = self.deck(deck).loop_end_sec;
      let duration_sec = (loop_end_sec - loop_start_sec).max(0.0);
      let has_reached_later_half = current_sec
        >= loop_start_sec + duration_sec * 0.5 - HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC;
      if current_sec < loop_start_sec + HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
        || current_sec >= loop_end_sec - HORIZONTAL_BROWSE_LOOP_END_EPSILON_SEC
        || has_reached_later_half
      {
        let now_ms = self.last_now_ms;
        let target = self.deck_mut(deck);
        target.current_sec = loop_start_sec;
        target.last_observed_at_ms = now_ms;
        horizontal_browse_transport_audio::reset_master_tempo_state(target);
      }
    }
  }

  pub(super) fn set_loop_from_range(&mut self, deck: DeckId, start_sec: f64, end_sec: f64) -> bool {
    let Some(grid) = self.beat_grid(deck) else {
      self.deactivate_loop(deck);
      return false;
    };
    let duration_sec = end_sec - start_sec;
    if !duration_sec.is_finite() || duration_sec <= HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC {
      self.deactivate_loop(deck);
      return false;
    }
    let start_beat_index = ((start_sec - grid.first_beat_sec) / grid.beat_sec).round() as i32;
    let raw_beat_value = duration_sec / grid.beat_sec;
    if !raw_beat_value.is_finite() || raw_beat_value <= 0.0 {
      self.deactivate_loop(deck);
      return false;
    }
    let nearest_beat_value = HORIZONTAL_BROWSE_LOOP_BEAT_VALUES
      .iter()
      .copied()
      .min_by(|left, right| {
        (left - raw_beat_value)
          .abs()
          .partial_cmp(&(right - raw_beat_value).abs())
          .unwrap_or(std::cmp::Ordering::Equal)
      })
      .unwrap_or(HORIZONTAL_BROWSE_LOOP_DEFAULT_BEAT_VALUE);
    {
      let target = self.deck_mut(deck);
      target.loop_active = true;
      target.loop_start_beat_index = Some(start_beat_index);
      target.loop_beat_value = nearest_beat_value;
    }
    self.sync_loop_range_for_deck(deck)
  }

  pub(super) fn effective_bpm_for_deck(&self, deck: DeckId) -> f64 {
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

  pub(super) fn estimate_current_sec(deck: &DeckState, now_ms: f64) -> f64 {
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

  pub(super) fn resolve_leader_candidate(&self, requested: DeckId) -> Option<DeckId> {
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

  pub(super) fn resolve_bpm_multiplier(&self, deck: DeckId, master_effective_bpm: f64) -> f64 {
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

  pub(super) fn update_multipliers(&mut self) {
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

  pub(super) fn derive_state(&self, deck: DeckId, now_ms: f64) -> DeckDerivedState {
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

  pub(super) fn recompute_distances(&mut self) {
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

  pub(super) fn target_sec_from_beat_distance(grid: BeatGridSnapshot, beat_distance: f64) -> f64 {
    grid.first_beat_sec + beat_distance * grid.beat_sec
  }

  pub(super) fn nearest_valid_beat_distance_with_phase(
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

  pub(super) fn snapshot(&self, now_ms: f64) -> HorizontalBrowseTransportSnapshot {
    let top = self.deck_snapshot(DeckId::Top, now_ms);
    let bottom = self.deck_snapshot(DeckId::Bottom, now_ms);
    HorizontalBrowseTransportSnapshot {
      leader_deck: self.leader.map(|deck| deck.as_str().to_string()),
      top,
      bottom,
      output: self.output_snapshot(),
    }
  }

  pub(super) fn output_snapshot(&self) -> HorizontalBrowseTransportOutputSnapshot {
    HorizontalBrowseTransportOutputSnapshot {
      crossfader_value: self.crossfader_value as f64,
      master_gain: self.master_gain as f64,
      top_deck_gain: self.top.gain as f64,
      bottom_deck_gain: self.bottom.gain as f64,
    }
  }

  pub(super) fn deck_snapshot(
    &self,
    deck: DeckId,
    now_ms: f64,
  ) -> HorizontalBrowseTransportDeckSnapshot {
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
      loop_active: deck_state.loop_active,
      loop_beat_value: deck_state.loop_beat_value,
      loop_start_beat_index: deck_state.loop_start_beat_index,
      loop_start_sec: deck_state.loop_start_sec,
      loop_end_sec: deck_state.loop_end_sec,
    }
  }

  fn relax_sync_lock_after_grid_change(&mut self, updated_deck: DeckId) {
    let leader = self.leader;
    for deck in [DeckId::Top, DeckId::Bottom] {
      let index = Self::deck_index(deck);
      if !self.sync_enabled[index] || self.sync_lock[index] == "off" {
        continue;
      }
      if leader == Some(deck) {
        continue;
      }
      if deck == updated_deck || leader == Some(updated_deck) {
        self.set_sync_lock(deck, "tempo-only");
      }
    }
  }

  fn refresh_sync_state(&mut self, allow_phase_alignment: bool) {
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

        if allow_phase_alignment
          && self.sync_lock[deck_index] == "full"
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

  pub(super) fn refresh(&mut self) {
    self.refresh_sync_state(true);
  }

  pub(super) fn set_beat_grid(
    &mut self,
    deck: DeckId,
    bpm: Option<f64>,
    first_beat_ms: Option<f64>,
  ) {
    {
      let target = self.deck_mut(deck);
      if let Some(next_bpm) = bpm.filter(|value| value.is_finite() && *value > 0.0) {
        target.bpm = Some(next_bpm);
      }
      if let Some(next_first_beat_ms) =
        first_beat_ms.filter(|value| value.is_finite() && *value >= 0.0)
      {
        target.first_beat_ms = Some(next_first_beat_ms);
      }
      target.metronome_state.next_beat_index = None;
    }
    self.relax_sync_lock_after_grid_change(deck);
    self.refresh_sync_state(false);
    self.sync_loop_range_for_deck(DeckId::Top);
    self.sync_loop_range_for_deck(DeckId::Bottom);
  }

  pub(super) fn sync_deck_to_now(&mut self, deck: DeckId, now_ms: f64) {
    let estimated = Self::estimate_current_sec(self.deck(deck), now_ms);
    let target = self.deck_mut(deck);
    target.current_sec = estimated;
    target.last_observed_at_ms = now_ms;
  }

  pub(super) fn set_leader(&mut self, deck: Option<DeckId>) {
    self.leader = deck.filter(|candidate| self.is_loaded(*candidate));
    self.refresh();
  }

  pub(super) fn set_output_state(&mut self, crossfader_value: f64, master_gain: f64) {
    self.crossfader_value = Self::clamp_crossfader_value(crossfader_value);
    self.master_gain = Self::clamp_unit_gain(master_gain);
    self.refresh_output_gains();
  }

  pub(super) fn sync_loop_before_play(&mut self, deck: DeckId) {
    if !self.deck(deck).loop_active {
      return;
    }
    let loop_start_sec = self.deck(deck).loop_start_sec;
    let loop_end_sec = self.deck(deck).loop_end_sec;
    let current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    if current_sec >= loop_start_sec + HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
      && current_sec < loop_end_sec - HORIZONTAL_BROWSE_LOOP_END_EPSILON_SEC
    {
      return;
    }
    let now_ms = self.last_now_ms;
    let target = self.deck_mut(deck);
    target.current_sec = loop_start_sec;
    target.last_observed_at_ms = now_ms;
    horizontal_browse_transport_audio::reset_master_tempo_state(target);
  }

  pub(super) fn set_playing(
    &mut self,
    deck: DeckId,
    now_ms: f64,
    playing: bool,
  ) -> Option<DecodeRequest> {
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    if playing {
      self.sync_loop_before_play(deck);
    }
    let current_sec = {
      let target = self.deck_mut(deck);
      target.playing = playing;
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
      target.current_sec
    };
    let decode_request = if playing && !self.has_pending_decode_for_current_file(deck) {
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

  pub(super) fn seek(
    &mut self,
    deck: DeckId,
    now_ms: f64,
    current_sec: f64,
  ) -> Option<DecodeRequest> {
    self.last_now_ms = now_ms;
    let seek_sec = {
      let target = self.deck_mut(deck);
      target.current_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
        current_sec.clamp(0.0, target.duration_sec)
      } else {
        current_sec.max(0.0)
      };
      target.last_observed_at_ms = now_ms;
      target.metronome_state.next_beat_index = None;
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

  pub(super) fn set_metronome(&mut self, deck: DeckId, enabled: bool, volume_level: u8) {
    let target = self.deck_mut(deck);
    target.metronome_enabled = enabled;
    target.metronome_volume_level = volume_level.clamp(1, 3);
    if !enabled {
      target.metronome_state = MetronomeState::default();
      return;
    }
    target.metronome_state.next_beat_index = None;
  }

  pub(super) fn toggle_loop(&mut self, deck: DeckId, now_ms: f64) {
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    if self.deck(deck).loop_active {
      self.deactivate_loop(deck);
      self.refresh();
      return;
    }
    let anchor_sec = if self.deck(deck).playing {
      Self::estimate_current_sec(self.deck(deck), now_ms)
    } else {
      self.deck(deck).current_sec
    };
    self.activate_loop_from_anchor(deck, anchor_sec);
    self.refresh();
  }

  pub(super) fn step_loop_beats_command(&mut self, deck: DeckId, direction: i32, now_ms: f64) {
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    self.step_loop_beats(deck, direction);
    self.refresh();
  }

  pub(super) fn set_loop_from_range_command(&mut self, deck: DeckId, start_sec: f64, end_sec: f64) {
    self.set_loop_from_range(deck, start_sec, end_sec);
    self.refresh();
  }

  pub(super) fn clear_loop(&mut self, deck: DeckId) {
    self.deactivate_loop(deck);
    self.refresh();
  }

  pub(super) fn set_sync_enabled(&mut self, deck: DeckId, enabled: bool) {
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

  pub(super) fn beatsync(&mut self, deck: DeckId) {
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
