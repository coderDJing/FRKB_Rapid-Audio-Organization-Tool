use super::*;

impl HorizontalBrowseTransportEngine {
  pub(super) fn normalize_bar_beat_offset(value: f64) -> f64 {
    if !value.is_finite() {
      return 0.0;
    }
    let rounded = value.round();
    ((rounded % 32.0) + 32.0) % 32.0
  }

  pub(super) fn deck_time_basis_offset_sec(deck_state: &DeckState) -> f64 {
    let raw = deck_state.time_basis_offset_ms.unwrap_or(0.0);
    if raw.is_finite() && raw > 0.0 {
      raw / 1000.0
    } else {
      0.0
    }
  }

  pub(super) fn timeline_sec_to_audio_sec(deck_state: &DeckState, timeline_sec: f64) -> f64 {
    (timeline_sec - Self::deck_time_basis_offset_sec(deck_state)).max(0.0)
  }

  pub(super) fn audio_sec_to_timeline_sec(deck_state: &DeckState, audio_sec: f64) -> f64 {
    (audio_sec + Self::deck_time_basis_offset_sec(deck_state)).max(0.0)
  }

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
      bar_beat_offset: Self::normalize_bar_beat_offset(deck_state.bar_beat_offset.unwrap_or(0.0)),
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
      bar_beat_offset: original.bar_beat_offset,
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
    let Some(grid) = self.original_beat_grid(deck) else {
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
    let Some(grid) = self.original_beat_grid(deck) else {
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
        {
          let target = self.deck_mut(deck);
          target.current_sec = loop_start_sec;
          target.last_observed_at_ms = now_ms;
        }
        self.reset_and_prime_master_tempo_state(deck);
      }
    }
  }

  pub(super) fn set_loop_from_range(&mut self, deck: DeckId, start_sec: f64, end_sec: f64) -> bool {
    let Some(grid) = self.original_beat_grid(deck) else {
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
    let now_ms = self.last_now_ms;
    if let Some(leader) = self.leader {
      if self.is_sync_ready(leader, now_ms) {
        return Some(leader);
      }
    }
    let other = requested.other();
    if self.is_playing_audible_at(other, now_ms) {
      return Some(other);
    }
    if self.is_sync_ready(other, now_ms) {
      return Some(other);
    }
    if self.is_sync_ready(requested, now_ms) {
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
    let playing_audible = deck_state.playing && self.has_loaded_segment_covering(deck, current_sec);
    if self.beat_grid(deck).is_none() {
      return DeckDerivedState {
        estimated_current_sec: current_sec,
        effective_bpm: 0.0,
        render_current_sec: current_sec,
        playing_audible,
      };
    }
    DeckDerivedState {
      estimated_current_sec: current_sec,
      effective_bpm: self.effective_bpm_for_deck(deck),
      render_current_sec: current_sec,
      playing_audible,
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

  pub(super) fn nearest_grid_offset_sec(grid: BeatGridSnapshot, current_sec: f64) -> f64 {
    if !current_sec.is_finite() || !grid.beat_sec.is_finite() || grid.beat_sec <= 0.0 {
      return 0.0;
    }
    let beat_distance = (current_sec - grid.first_beat_sec) / grid.beat_sec;
    if !beat_distance.is_finite() {
      return 0.0;
    }
    current_sec - Self::target_sec_from_beat_distance(grid, beat_distance.round())
  }

  pub(super) fn nearest_valid_sec_with_grid_offset(
    anchor_sec: f64,
    leader_current_sec: f64,
    leader_grid: BeatGridSnapshot,
    target_grid: BeatGridSnapshot,
    min_sec: f64,
    max_sec: f64,
  ) -> f64 {
    if !target_grid.beat_sec.is_finite() || target_grid.beat_sec <= 0.0 {
      return anchor_sec.clamp(min_sec, max_sec);
    }
    let leader_offset_sec = Self::nearest_grid_offset_sec(leader_grid, leader_current_sec);
    let min_index =
      ((min_sec - leader_offset_sec - target_grid.first_beat_sec) / target_grid.beat_sec).ceil();
    let max_index =
      ((max_sec - leader_offset_sec - target_grid.first_beat_sec) / target_grid.beat_sec).floor();
    if min_index > max_index {
      return anchor_sec.clamp(min_sec, max_sec);
    }
    let anchor_index = ((anchor_sec - leader_offset_sec - target_grid.first_beat_sec)
      / target_grid.beat_sec)
      .round()
      .clamp(min_index, max_index);
    (target_grid.first_beat_sec + anchor_index * target_grid.beat_sec + leader_offset_sec)
      .clamp(min_sec, max_sec)
  }

  pub(super) fn snapshot(&self, now_ms: f64) -> HorizontalBrowseTransportSnapshot {
    let top = self.deck_snapshot(DeckId::Top, now_ms);
    let bottom = self.deck_snapshot(DeckId::Bottom, now_ms);
    HorizontalBrowseTransportSnapshot {
      snapshot_sequence: next_snapshot_sequence(),
      state_revision: self.state_revision as f64,
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
    let playhead_loaded = self.has_loaded_segment_covering(deck, derived.estimated_current_sec);
    let full_decoding = deck_state.pending_full_decode_file_path.is_some();
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
      fully_decoded: self.is_fully_decoded(deck),
      decoding: deck_state.pending_decode_file_path.is_some() || full_decoding,
      full_decoding,
      play_requested: deck_state.playing,
      playing_audible: derived.playing_audible,
      playhead_loaded,
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
      if !self.is_sync_ready(leader, now_ms) {
        self.leader = None;
        for deck in [DeckId::Top, DeckId::Bottom] {
          self.set_sync_lock(deck, "off");
        }
        return;
      }
      let Some(leader_grid) = self.beat_grid(leader) else {
        return;
      };
      let Some(leader_visual_grid) = self.original_beat_grid(leader) else {
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
        if !self.is_sync_ready(deck, now_ms) {
          self.set_sync_lock(deck, "off");
          continue;
        }
        if self.beat_grid(deck).is_none() {
          continue;
        }
        let Some(target_visual_grid) = self.original_beat_grid(deck) else {
          continue;
        };
        let target_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
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
          && self.is_playing_audible_at(deck, now_ms)
        {
          let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
          let aligned_sec = Self::nearest_valid_sec_with_grid_offset(
            target_current_sec,
            leader_current_sec,
            leader_visual_grid,
            target_visual_grid,
            0.0,
            target_duration_sec,
          );
          let target = self.deck_mut(deck);
          target.current_sec = aligned_sec;
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
    bar_beat_offset: Option<f64>,
    time_basis_offset_ms: Option<f64>,
  ) {
    self.mark_state_changed();
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
      if let Some(next_bar_beat_offset) = bar_beat_offset.filter(|value| value.is_finite()) {
        target.bar_beat_offset = Some(Self::normalize_bar_beat_offset(next_bar_beat_offset));
      }
      if let Some(next_time_basis_offset_ms) =
        time_basis_offset_ms.filter(|value| value.is_finite() && *value >= 0.0)
      {
        target.time_basis_offset_ms = Some(next_time_basis_offset_ms);
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

  pub(super) fn apply_external_deck_state(
    &mut self,
    deck: DeckId,
    now_ms: f64,
    payload: HorizontalBrowseTransportDeckInput,
  ) {
    let current_file_path = self
      .deck(deck)
      .file_path
      .as_deref()
      .map(str::trim)
      .unwrap_or("")
      .to_string();
    let next_file_path = payload
      .file_path
      .as_deref()
      .map(str::trim)
      .unwrap_or("")
      .to_string();
    let same_file = current_file_path == next_file_path;
    let previous_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
    let preserve_playhead =
      same_file && !next_file_path.is_empty() && self.deck(deck).playing && payload.playing;
    let next_current_sec = if preserve_playhead {
      previous_current_sec
    } else {
      payload.current_sec
    };
    let position_changed = !preserve_playhead
      && (previous_current_sec - next_current_sec).abs()
        > HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC;
    let file_changed = !same_file;
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));

    {
      let target = self.deck_mut(deck);
      target.file_path = payload.file_path;
      target.title = payload.title;
      target.bpm = payload.bpm;
      target.first_beat_ms = payload.first_beat_ms;
      target.bar_beat_offset = payload
        .bar_beat_offset
        .filter(|value| value.is_finite())
        .map(HorizontalBrowseTransportEngine::normalize_bar_beat_offset);
      target.time_basis_offset_ms = payload.time_basis_offset_ms;
      target.duration_sec = payload.duration_sec;
      target.current_sec = next_current_sec;
      target.last_observed_at_ms = if preserve_playhead {
        now_ms
      } else {
        payload.last_observed_at_ms
      };
      target.playing = payload.playing;
      target.playback_rate = Self::normalize_playback_rate(payload.playback_rate);
      target.master_tempo_enabled = payload.master_tempo_enabled;
      target.metronome_state.next_beat_index = None;
    }

    self.sync_master_tempo_state_after_change(
      deck,
      was_master_tempo_active,
      file_changed || position_changed,
    );
  }

  pub(super) fn set_playback_rate(&mut self, deck: DeckId, now_ms: f64, playback_rate: f64) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    {
      let target = self.deck_mut(deck);
      target.playback_rate = Self::normalize_playback_rate(playback_rate);
    }
    self.sync_master_tempo_state_after_change(deck, was_master_tempo_active, false);
    self.refresh_sync_state(false);
  }

  pub(super) fn set_master_tempo_enabled(&mut self, deck: DeckId, now_ms: f64, enabled: bool) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    let was_master_tempo_active =
      horizontal_browse_transport_audio::should_use_master_tempo(self.deck(deck));
    {
      let target = self.deck_mut(deck);
      target.master_tempo_enabled = enabled;
    }
    self.sync_master_tempo_state_after_change(deck, was_master_tempo_active, false);
  }

  pub(super) fn set_leader(&mut self, deck: Option<DeckId>) {
    self.mark_state_changed();
    self.leader = deck.filter(|candidate| self.is_loaded(*candidate));
    self.refresh();
  }

  pub(super) fn set_output_state(&mut self, crossfader_value: f64, master_gain: f64) {
    self.mark_state_changed();
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
    {
      let target = self.deck_mut(deck);
      target.current_sec = loop_start_sec;
      target.last_observed_at_ms = now_ms;
    }
    self.reset_and_prime_master_tempo_state(deck);
  }

  pub(super) fn set_playing(&mut self, deck: DeckId, now_ms: f64, playing: bool) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    if playing {
      self.sync_loop_before_play(deck);
    }
    {
      let target = self.deck_mut(deck);
      target.playing = playing;
    }
    self.reset_and_prime_master_tempo_state(deck);
    self.refresh();
  }

  pub(super) fn seek(&mut self, deck: DeckId, now_ms: f64, current_sec: f64) {
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    {
      let target = self.deck_mut(deck);
      target.current_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
        current_sec.clamp(0.0, target.duration_sec)
      } else {
        current_sec.max(0.0)
      };
      target.last_observed_at_ms = now_ms;
      target.metronome_state.next_beat_index = None;
    }
    self.reset_and_prime_master_tempo_state(deck);
    self.refresh();
  }

  pub(super) fn set_metronome(&mut self, deck: DeckId, enabled: bool, volume_level: u8) {
    self.mark_state_changed();
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
    self.mark_state_changed();
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
    self.mark_state_changed();
    self.last_now_ms = now_ms;
    self.sync_deck_to_now(deck, now_ms);
    self.step_loop_beats(deck, direction);
    self.refresh();
  }

  pub(super) fn set_loop_from_range_command(&mut self, deck: DeckId, start_sec: f64, end_sec: f64) {
    self.mark_state_changed();
    self.set_loop_from_range(deck, start_sec, end_sec);
    self.refresh();
  }

  pub(super) fn clear_loop(&mut self, deck: DeckId) {
    self.mark_state_changed();
    self.deactivate_loop(deck);
    self.refresh();
  }

  pub(super) fn set_sync_enabled(&mut self, deck: DeckId, enabled: bool) {
    self.mark_state_changed();
    self.sync_deck_to_now(deck, self.last_now_ms);
    let index = Self::deck_index(deck);
    self.sync_enabled[index] = enabled;
    if !enabled {
      self.set_sync_lock(deck, "off");
      self.refresh_sync_state(false);
      return;
    }
    let leader = self.resolve_leader_candidate(deck);
    if self.leader != leader {
      self.leader = leader;
    }
    self.refresh_sync_state(false);
  }

  pub(super) fn beatsync(&mut self, deck: DeckId) {
    self.mark_state_changed();
    let Some(leader) = self.resolve_leader_candidate(deck) else {
      return;
    };
    if leader == deck {
      self.leader = Some(deck);
      self.sync_enabled[Self::deck_index(deck)] = true;
      self.set_sync_lock(deck, "full");
      self.refresh_sync_state(false);
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
    if let (Some(target_grid), Some(leader_visual_grid), Some(target_visual_grid)) = (
      self.beat_grid(deck),
      self.original_beat_grid(leader),
      self.original_beat_grid(deck),
    ) {
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let target_current_sec = Self::estimate_current_sec(self.deck(deck), now_ms);
      let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
      let target_sec = Self::nearest_valid_sec_with_grid_offset(
        target_current_sec,
        leader_current_sec,
        leader_visual_grid,
        target_visual_grid,
        0.0,
        target_duration_sec,
      );
      let target = self.deck_mut(deck);
      target.current_sec = target_sec.clamp(0.0, target.duration_sec.max(0.0));
      target.last_observed_at_ms = now_ms;
      self.deck_mut(deck).playback_rate = (leader_effective_bpm / target_grid.bpm).clamp(0.25, 4.0);
      self.reset_and_prime_master_tempo_state(deck);
    }
    self.refresh_sync_state(false);
  }

  pub(super) fn align_to_leader(&mut self, deck: DeckId, target_sec: Option<f64>) {
    self.mark_state_changed();
    let Some(leader) = self.resolve_leader_candidate(deck) else {
      return;
    };
    if leader == deck {
      self.leader = Some(deck);
      self.sync_enabled[Self::deck_index(deck)] = true;
      self.set_sync_lock(deck, "full");
      self.refresh_sync_state(false);
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

    if let (Some(target_grid), Some(leader_visual_grid), Some(target_visual_grid)) = (
      self.beat_grid(deck),
      self.original_beat_grid(leader),
      self.original_beat_grid(deck),
    ) {
      let leader_current_sec = Self::estimate_current_sec(self.deck(leader), now_ms);
      let anchor_sec = target_sec
        .filter(|value| value.is_finite())
        .unwrap_or_else(|| Self::estimate_current_sec(self.deck(deck), now_ms));
      let target_duration_sec = self.deck(deck).duration_sec.max(0.0);
      let target_sec = Self::nearest_valid_sec_with_grid_offset(
        anchor_sec.max(0.0),
        leader_current_sec,
        leader_visual_grid,
        target_visual_grid,
        0.0,
        target_duration_sec,
      );
      let target = self.deck_mut(deck);
      target.current_sec = if target.duration_sec.is_finite() && target.duration_sec > 0.0 {
        target_sec.clamp(0.0, target.duration_sec)
      } else {
        target_sec.max(0.0)
      };
      target.last_observed_at_ms = now_ms;
      target.playback_rate = (leader_effective_bpm / target_grid.bpm).clamp(0.25, 4.0);
      target.metronome_state.next_beat_index = None;
      self.reset_and_prime_master_tempo_state(deck);
    }

    self.refresh_sync_state(false);
  }
}
