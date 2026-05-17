use super::*;

impl HorizontalBrowseTransportEngine {
  fn grid_value_changed(current: Option<f64>, next: f64) -> bool {
    current
      .map(|value| (value - next).abs() > 0.000001)
      .unwrap_or(true)
  }

  fn set_grid_value(current: &mut Option<f64>, next: Option<f64>) -> bool {
    let Some(value) = next else {
      return false;
    };
    if !Self::grid_value_changed(*current, value) {
      return false;
    }
    *current = Some(value);
    true
  }

  pub(super) fn set_beat_grid(
    &mut self,
    deck: DeckId,
    bpm: Option<f64>,
    first_beat_ms: Option<f64>,
    bar_beat_offset: Option<f64>,
    time_basis_offset_ms: Option<f64>,
  ) {
    let sync_reference = self.resolve_grid_change_sync_reference(deck);
    let previous_current_sec = Self::estimate_current_sec(self.deck(deck), self.last_now_ms);
    let mut grid_changed = false;
    let audio_timeline_mapping_changed;
    let next_bpm = bpm.filter(|value| value.is_finite() && *value > 0.0);
    let next_first_beat_ms = first_beat_ms.filter(|value| value.is_finite() && *value >= 0.0);
    let next_bar_beat_offset = bar_beat_offset
      .filter(|value| value.is_finite())
      .map(Self::normalize_bar_beat_offset);
    let next_time_basis_offset_ms =
      time_basis_offset_ms.filter(|value| value.is_finite() && *value >= 0.0);
    {
      let target = self.deck_mut(deck);
      grid_changed |= Self::set_grid_value(&mut target.bpm, next_bpm);
      grid_changed |= Self::set_grid_value(&mut target.first_beat_ms, next_first_beat_ms);
      grid_changed |= Self::set_grid_value(&mut target.bar_beat_offset, next_bar_beat_offset);
      audio_timeline_mapping_changed =
        Self::set_grid_value(&mut target.time_basis_offset_ms, next_time_basis_offset_ms);
      grid_changed |= audio_timeline_mapping_changed;
      if grid_changed {
        target.metronome_state.next_beat_index = None;
      }
    }
    if !grid_changed {
      return;
    }
    self.mark_state_changed();
    let kept_full_sync = sync_reference
      .map(|reference| self.apply_grid_change_sync_compensation(deck, reference))
      .unwrap_or(false);
    if !kept_full_sync {
      self.relax_sync_lock_after_grid_change(deck);
    }
    let next_current_sec = self.deck(deck).current_sec;
    let playback_position_changed = (next_current_sec - previous_current_sec).abs()
      > HORIZONTAL_BROWSE_LOOP_POSITION_EPSILON_SEC
      || audio_timeline_mapping_changed;
    if playback_position_changed {
      {
        let target = self.deck_mut(deck);
        target.scrub_preview.active = false;
        target.scrub_preview.rate = 0.0;
        horizontal_browse_transport_audio::reset_band_filter_state(target);
      }
      self.reset_and_prime_master_tempo_state(deck);
    }
    self.refresh_sync_state(false);
    self.sync_loop_range_for_deck(DeckId::Top);
    self.sync_loop_range_for_deck(DeckId::Bottom);
  }

  pub(super) fn resolve_grid_change_sync_reference(&self, updated_deck: DeckId) -> Option<DeckId> {
    let leader = self.leader?;
    let now_ms = self.last_now_ms;
    let updated_grid_ready = self.original_beat_grid(updated_deck).is_some();
    if !self.is_sync_ready(updated_deck, now_ms) || !updated_grid_ready {
      return None;
    }

    if updated_deck == leader {
      for candidate in [DeckId::Top, DeckId::Bottom] {
        let candidate_index = Self::deck_index(candidate);
        if candidate == updated_deck
          || !self.sync_enabled[candidate_index]
          || self.sync_lock[candidate_index] != "full"
          || !self.is_sync_ready(candidate, now_ms)
          || self.original_beat_grid(candidate).is_none()
        {
          continue;
        }
        return Some(candidate);
      }
      return None;
    }

    let updated_index = Self::deck_index(updated_deck);
    if !self.sync_enabled[updated_index]
      || self.sync_lock[updated_index] != "full"
      || !self.is_sync_ready(leader, now_ms)
      || self.original_beat_grid(leader).is_none()
    {
      return None;
    }
    Some(leader)
  }

  fn nearest_sec_with_grid_offset(
    anchor_sec: f64,
    desired_offset_sec: f64,
    grid: BeatGridSnapshot,
  ) -> f64 {
    if !anchor_sec.is_finite() || !grid.beat_sec.is_finite() || grid.beat_sec <= 0.0 {
      return anchor_sec;
    }
    let anchor_index =
      ((anchor_sec - desired_offset_sec - grid.first_beat_sec) / grid.beat_sec).round();
    grid.first_beat_sec + anchor_index * grid.beat_sec + desired_offset_sec
  }

  pub(super) fn apply_grid_change_sync_compensation(
    &mut self,
    updated_deck: DeckId,
    reference_deck: DeckId,
  ) -> bool {
    let now_ms = self.last_now_ms;
    if !self.is_sync_ready(updated_deck, now_ms) || !self.is_sync_ready(reference_deck, now_ms) {
      return false;
    }
    let Some(reference_grid) = self.original_beat_grid(reference_deck) else {
      return false;
    };
    let Some(updated_grid) = self.original_beat_grid(updated_deck) else {
      return false;
    };
    let reference_current_sec = Self::estimate_current_sec(self.deck(reference_deck), now_ms);
    let updated_current_sec = Self::estimate_current_sec(self.deck(updated_deck), now_ms);
    let reference_offset_sec = Self::nearest_grid_offset_sec(reference_grid, reference_current_sec);
    let mut aligned_sec =
      Self::nearest_sec_with_grid_offset(updated_current_sec, reference_offset_sec, updated_grid);
    let duration_sec = self.deck(updated_deck).duration_sec;
    if duration_sec.is_finite() && duration_sec > 0.0 {
      aligned_sec = aligned_sec.min(duration_sec);
    }
    if !aligned_sec.is_finite() {
      return false;
    }

    let target = self.deck_mut(updated_deck);
    target.current_sec = aligned_sec;
    target.last_observed_at_ms = now_ms;
    target.metronome_state.next_beat_index = None;
    true
  }
}
