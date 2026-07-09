use super::*;

#[derive(Clone, Copy)]
struct DynamicBeatGridLineSnapshot {
  sec: f64,
  beat_ordinal: f64,
}

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

  fn dynamic_grid_first_beat_index(start_sec: f64, anchor_sec: f64, beat_sec: f64) -> i64 {
    ((start_sec - anchor_sec - HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC) / beat_sec).ceil()
      as i64
  }

  fn dynamic_grid_last_beat_index(end_sec: f64, anchor_sec: f64, beat_sec: f64) -> i64 {
    ((end_sec - anchor_sec - HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC) / beat_sec).floor()
      as i64
  }

  pub(super) fn normalize_dynamic_beat_grid(
    raw_clips: Option<Vec<HorizontalBrowseTransportBeatGridClipInput>>,
    duration_sec: f64,
  ) -> Vec<DynamicBeatGridClipSnapshot> {
    let Some(raw_clips) = raw_clips else {
      return Vec::new();
    };
    if !duration_sec.is_finite() || duration_sec <= 0.0 || raw_clips.len() < 2 {
      return Vec::new();
    }

    let mut normalized = Vec::new();
    for clip in raw_clips {
      if !clip.start_sec.is_finite()
        || clip.start_sec < 0.0
        || !clip.anchor_sec.is_finite()
        || !clip.bpm.is_finite()
        || clip.bpm <= 0.0
      {
        return Vec::new();
      }
      normalized.push((
        clip.start_sec.max(0.0),
        clip.anchor_sec,
        clip.bpm,
        Self::normalize_bar_beat_offset(clip.bar_beat_offset),
      ));
    }
    normalized.sort_by(|left, right| {
      left
        .0
        .partial_cmp(&right.0)
        .unwrap_or(std::cmp::Ordering::Equal)
    });
    if normalized.is_empty() || normalized[0].0.abs() > HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC
    {
      return Vec::new();
    }
    normalized[0].0 = 0.0;
    for index in 1..normalized.len() {
      if normalized[index].0 <= normalized[index - 1].0
        || normalized[index].0 <= 0.0
        || normalized[index].0 >= duration_sec
      {
        return Vec::new();
      }
    }

    let mut result = Vec::new();
    let mut first_beat_ordinal = 0_i64;
    for index in 0..normalized.len() {
      let (start_sec, anchor_sec, bpm, bar_beat_offset) = normalized[index];
      let end_sec = normalized
        .get(index + 1)
        .map(|clip| clip.0)
        .unwrap_or(duration_sec);
      let beat_sec = 60.0 / bpm;
      if !beat_sec.is_finite() || beat_sec <= 0.0 || end_sec <= start_sec {
        return Vec::new();
      }
      let first_beat_index = Self::dynamic_grid_first_beat_index(start_sec, anchor_sec, beat_sec);
      let last_beat_index = Self::dynamic_grid_last_beat_index(end_sec, anchor_sec, beat_sec);
      let line_count = (last_beat_index - first_beat_index + 1).max(0);
      result.push(DynamicBeatGridClipSnapshot {
        start_sec,
        end_sec,
        anchor_sec,
        bpm,
        beat_sec,
        bar_beat_offset,
        first_beat_index,
        first_beat_ordinal,
        line_count,
      });
      first_beat_ordinal += line_count;
    }
    if result.len() < 2 || first_beat_ordinal <= 0 {
      Vec::new()
    } else {
      result
    }
  }

  pub(super) fn dynamic_grid_clip_at_sec(
    deck_state: &DeckState,
    sec: f64,
  ) -> Option<DynamicBeatGridClipSnapshot> {
    if deck_state.dynamic_beat_grid.is_empty() {
      return None;
    }
    let safe_sec = if sec.is_finite() { sec.max(0.0) } else { 0.0 };
    let mut answer = deck_state.dynamic_beat_grid[0];
    for clip in &deck_state.dynamic_beat_grid {
      if clip.start_sec <= safe_sec + HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC {
        answer = *clip;
      } else {
        break;
      }
    }
    if safe_sec <= answer.end_sec + HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC {
      Some(answer)
    } else {
      None
    }
  }

  fn dynamic_grid_first_line_sec(clip: DynamicBeatGridClipSnapshot) -> f64 {
    clip.anchor_sec + clip.first_beat_index as f64 * clip.beat_sec
  }

  pub(super) fn dynamic_grid_as_fixed_snapshot(
    clip: DynamicBeatGridClipSnapshot,
  ) -> BeatGridSnapshot {
    BeatGridSnapshot {
      bpm: clip.bpm,
      beat_sec: clip.beat_sec,
      first_beat_sec: Self::dynamic_grid_first_line_sec(clip),
      bar_beat_offset: clip.bar_beat_offset,
    }
  }

  fn normalized_bpm_multiplier(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
      value
    } else {
      1.0
    }
  }

  fn dynamic_grid_beat_sec_for_multiplier(
    clip: DynamicBeatGridClipSnapshot,
    multiplier: f64,
  ) -> f64 {
    clip.beat_sec / Self::normalized_bpm_multiplier(multiplier)
  }

  fn dynamic_grid_beat_lines_for_multiplier(
    deck_state: &DeckState,
    multiplier: f64,
  ) -> Vec<DynamicBeatGridLineSnapshot> {
    if deck_state.dynamic_beat_grid.is_empty() {
      return Vec::new();
    }
    let mut lines = Vec::new();
    let mut next_beat_ordinal = 0_i64;
    for clip in &deck_state.dynamic_beat_grid {
      let beat_sec = Self::dynamic_grid_beat_sec_for_multiplier(*clip, multiplier);
      if !beat_sec.is_finite() || beat_sec <= 0.0 || clip.end_sec <= clip.start_sec {
        continue;
      }
      let first_beat_index = Self::dynamic_grid_first_beat_index(
        clip.start_sec,
        clip.anchor_sec,
        beat_sec,
      );
      let last_beat_index =
        Self::dynamic_grid_last_beat_index(clip.end_sec, clip.anchor_sec, beat_sec);
      for beat_index in first_beat_index..=last_beat_index {
        let sec = clip.anchor_sec + beat_index as f64 * beat_sec;
        if sec < clip.start_sec - HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC {
          continue;
        }
        if sec >= clip.end_sec - HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC
          && clip.end_sec < deck_state.duration_sec
        {
          continue;
        }
        if sec > deck_state.duration_sec + HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC {
          continue;
        }
        lines.push(DynamicBeatGridLineSnapshot {
          sec: sec.clamp(0.0, deck_state.duration_sec.max(0.0)),
          beat_ordinal: next_beat_ordinal as f64,
        });
        next_beat_ordinal += 1;
      }
    }
    lines
  }

  pub(super) fn dynamic_beat_distance_at_sec_with_multiplier(
    deck_state: &DeckState,
    sec: f64,
    multiplier: f64,
  ) -> Option<f64> {
    let lines = Self::dynamic_grid_beat_lines_for_multiplier(deck_state, multiplier);
    if lines.is_empty() {
      return None;
    }
    let safe_sec = if sec.is_finite() { sec } else { 0.0 };
    let first_line = lines[0];
    if safe_sec <= first_line.sec {
      let clip = Self::dynamic_grid_clip_at_sec(deck_state, safe_sec).unwrap_or(
        deck_state
          .dynamic_beat_grid
          .first()
          .copied()
          .unwrap_or(DynamicBeatGridClipSnapshot {
            start_sec: 0.0,
            end_sec: deck_state.duration_sec.max(0.0),
            anchor_sec: first_line.sec,
            bpm: 120.0,
            beat_sec: 0.5,
            bar_beat_offset: 0.0,
            first_beat_index: 0,
            first_beat_ordinal: 0,
            line_count: 0,
          }),
      );
      let beat_sec = Self::dynamic_grid_beat_sec_for_multiplier(clip, multiplier);
      if !beat_sec.is_finite() || beat_sec <= 0.0 {
        return None;
      }
      return Some(first_line.beat_ordinal + (safe_sec - first_line.sec) / beat_sec);
    }
    for pair in lines.windows(2) {
      let left = pair[0];
      let right = pair[1];
      if safe_sec < left.sec || safe_sec > right.sec {
        continue;
      }
      let span_sec = right.sec - left.sec;
      if !span_sec.is_finite() || span_sec <= HORIZONTAL_BROWSE_DYNAMIC_GRID_EPSILON_SEC {
        return Some(left.beat_ordinal);
      }
      return Some(left.beat_ordinal + (safe_sec - left.sec) / span_sec);
    }
    let last_line = *lines.last()?;
    let clip = Self::dynamic_grid_clip_at_sec(deck_state, safe_sec)
      .or_else(|| deck_state.dynamic_beat_grid.last().copied())?;
    let beat_sec = Self::dynamic_grid_beat_sec_for_multiplier(clip, multiplier);
    if !beat_sec.is_finite() || beat_sec <= 0.0 {
      return None;
    }
    Some(last_line.beat_ordinal + (safe_sec - last_line.sec) / beat_sec)
  }

  pub(super) fn dynamic_sec_at_beat_distance_with_multiplier(
    deck_state: &DeckState,
    beat_distance: f64,
    multiplier: f64,
  ) -> Option<f64> {
    if !beat_distance.is_finite() {
      return None;
    }
    let lines = Self::dynamic_grid_beat_lines_for_multiplier(deck_state, multiplier);
    if lines.is_empty() {
      return None;
    }
    let first_line = lines[0];
    if beat_distance <= first_line.beat_ordinal {
      let clip = deck_state.dynamic_beat_grid.first().copied()?;
      let beat_sec = Self::dynamic_grid_beat_sec_for_multiplier(clip, multiplier);
      if !beat_sec.is_finite() || beat_sec <= 0.0 {
        return None;
      }
      return Some(first_line.sec + (beat_distance - first_line.beat_ordinal) * beat_sec);
    }
    for pair in lines.windows(2) {
      let left = pair[0];
      let right = pair[1];
      if beat_distance < left.beat_ordinal || beat_distance > right.beat_ordinal {
        continue;
      }
      let span_beats = right.beat_ordinal - left.beat_ordinal;
      if !span_beats.is_finite() || span_beats <= 0.0 {
        return Some(left.sec);
      }
      let ratio = ((beat_distance - left.beat_ordinal) / span_beats).clamp(0.0, 1.0);
      return Some(left.sec + (right.sec - left.sec) * ratio);
    }
    let last_line = *lines.last()?;
    let clip = deck_state.dynamic_beat_grid.last().copied()?;
    let beat_sec = Self::dynamic_grid_beat_sec_for_multiplier(clip, multiplier);
    if !beat_sec.is_finite() || beat_sec <= 0.0 {
      return None;
    }
    Some(last_line.sec + (beat_distance - last_line.beat_ordinal) * beat_sec)
  }
}
