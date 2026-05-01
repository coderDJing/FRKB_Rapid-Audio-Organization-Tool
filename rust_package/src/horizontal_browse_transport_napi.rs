use super::*;

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
  engine_guard.observe_external_now_ms(now_ms.unwrap_or(payload.last_observed_at_ms));
  let apply_now_ms = engine_guard.last_now_ms;
  engine_guard.apply_external_deck_state(deck_id, apply_now_ms, payload);
  engine_guard.mark_state_changed();
  let decode_request = engine_guard.prepare_decode_request(deck_id);
  let full_decode_request = engine_guard.prepare_full_decode_request(deck_id);
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
  if let Some(request) = full_decode_request {
    schedule_decode_request(request);
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
  engine_guard.observe_external_now_ms(now_ms);
  let apply_now_ms = engine_guard.last_now_ms;
  engine_guard.apply_external_deck_state(DeckId::Top, apply_now_ms, payload.top);
  engine_guard.apply_external_deck_state(DeckId::Bottom, apply_now_ms, payload.bottom);
  engine_guard.mark_state_changed();
  let top_decode_request = engine_guard.prepare_decode_request(DeckId::Top);
  let bottom_decode_request = engine_guard.prepare_decode_request(DeckId::Bottom);
  let top_full_decode_request = engine_guard.prepare_full_decode_request(DeckId::Top);
  let bottom_full_decode_request = engine_guard.prepare_full_decode_request(DeckId::Bottom);
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
  if let Some(request) = top_full_decode_request {
    schedule_decode_request(request);
  }
  if let Some(request) = bottom_full_decode_request {
    schedule_decode_request(request);
  }
  let engine_guard = engine().lock();
  engine_guard.snapshot(engine_guard.last_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_set_playback_rate(
  deck: String,
  now_ms: f64,
  playback_rate: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.set_playback_rate(deck_id, now_ms, playback_rate);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_master_tempo_enabled(
  deck: String,
  now_ms: f64,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.set_master_tempo_enabled(deck_id, now_ms, enabled);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_beat_grid(
  deck: String,
  now_ms: Option<f64>,
  payload: HorizontalBrowseTransportBeatGridInput,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  if let Some(next_now_ms) = now_ms.filter(|value| value.is_finite() && *value >= 0.0) {
    engine_guard.observe_external_now_ms(next_now_ms);
  }

  if let Some(expected_file_path) = payload.file_path.as_deref().map(str::trim) {
    if !expected_file_path.is_empty() {
      let current_file_path = engine_guard
        .deck(deck_id)
        .file_path
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
      if current_file_path != expected_file_path {
        return Ok(engine_guard.snapshot(engine_guard.last_now_ms));
      }
    }
  }

  let next_bpm = payload
    .bpm
    .filter(|value| value.is_finite() && *value > 0.0);
  let next_first_beat_ms = payload
    .first_beat_ms
    .filter(|value| value.is_finite() && *value >= 0.0);
  let next_bar_beat_offset = payload.bar_beat_offset.filter(|value| value.is_finite());
  let next_time_basis_offset_ms = payload
    .time_basis_offset_ms
    .filter(|value| value.is_finite() && *value >= 0.0);
  if next_bpm.is_none()
    && next_first_beat_ms.is_none()
    && next_bar_beat_offset.is_none()
    && next_time_basis_offset_ms.is_none()
  {
    return Ok(engine_guard.snapshot(engine_guard.last_now_ms));
  }
  engine_guard.set_beat_grid(
    deck_id,
    next_bpm,
    next_first_beat_ms,
    next_bar_beat_offset,
    next_time_basis_offset_ms,
  );
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_sync_enabled(
  deck: String,
  now_ms: Option<f64>,
  enabled: bool,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  if let Some(next_now_ms) = now_ms {
    engine.observe_external_now_ms(next_now_ms);
  }
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
  if let Some(next_now_ms) = now_ms {
    engine.observe_external_now_ms(next_now_ms);
  }
  engine.beatsync(deck_id);
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_align_to_leader(
  deck: String,
  now_ms: Option<f64>,
  target_sec: Option<f64>,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  if let Some(next_now_ms) = now_ms {
    engine_guard.observe_external_now_ms(next_now_ms);
  }
  engine_guard.align_to_leader(deck_id, target_sec);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
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
  if let Some(next_now_ms) = now_ms {
    engine.observe_external_now_ms(next_now_ms);
  }
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
  engine_guard.observe_external_now_ms(now_ms);
  let _ = engine_guard.ensure_output_stream();
  engine_guard.set_playing(deck_id, now_ms, playing);
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
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.seek(deck_id, now_ms, current_sec);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_metronome(
  deck: String,
  enabled: bool,
  volume_level: u32,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.set_metronome(deck_id, enabled, volume_level.clamp(1, 3) as u8);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_toggle_loop(
  deck: String,
  now_ms: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.toggle_loop(deck_id, now_ms);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_step_loop_beats(
  deck: String,
  now_ms: f64,
  direction: i32,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.observe_external_now_ms(now_ms);
  engine_guard.step_loop_beats_command(deck_id, direction.signum(), now_ms);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_loop_from_range(
  deck: String,
  start_sec: f64,
  end_sec: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.set_loop_from_range_command(deck_id, start_sec, end_sec);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_clear_loop(
  deck: String,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine_guard = engine().lock();
  engine_guard.clear_loop(deck_id);
  Ok(engine_guard.snapshot(engine_guard.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_gain(
  deck: String,
  gain: f64,
) -> napi::Result<HorizontalBrowseTransportSnapshot> {
  let deck_id = parse_deck_id(&deck)?;
  let mut engine = engine().lock();
  engine.mark_state_changed();
  engine.trim_gain[HorizontalBrowseTransportEngine::deck_index(deck_id)] =
    HorizontalBrowseTransportEngine::clamp_unit_gain(gain);
  engine.refresh_output_gains();
  Ok(engine.snapshot(engine.last_now_ms))
}

#[napi]
pub fn horizontal_browse_transport_set_output_state(
  crossfader_value: f64,
  master_gain: f64,
) -> HorizontalBrowseTransportSnapshot {
  let mut engine = engine().lock();
  engine.set_output_state(crossfader_value, master_gain);
  engine.snapshot(engine.last_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_snapshot(
  now_ms: Option<f64>,
) -> HorizontalBrowseTransportSnapshot {
  let engine = engine().lock();
  let snapshot_now_ms = now_ms
    .filter(|value| value.is_finite() && *value >= 0.0)
    .unwrap_or_else(|| engine.current_external_now_ms());
  engine.snapshot(snapshot_now_ms)
}

#[napi]
pub fn horizontal_browse_transport_visualizer_snapshot(
) -> HorizontalBrowseTransportVisualizerSnapshot {
  let engine = engine().lock();
  engine.visualizer_snapshot()
}
