use super::*;

impl HorizontalBrowseTransportEngine {
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
