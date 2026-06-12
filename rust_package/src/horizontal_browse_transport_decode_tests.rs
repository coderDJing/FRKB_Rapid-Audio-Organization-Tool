use std::sync::Arc;

use super::*;

#[test]
fn full_decode_marks_snapshot_ready_and_invalidates_pending_segment_result() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("full.mp3".to_string());
    top.loaded_file_path = Some("full.mp3".to_string());
    top.pending_decode_file_path = Some("full.mp3".to_string());
    top.pending_full_decode_file_path = Some("full.mp3".to_string());
    top.decode_request_id = 4;
    top.full_decode_request_id = 9;
    top.duration_sec = 10.0;
    top.current_sec = 6.0;
    top.pcm_start_sec = 0.0;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_data = Arc::new(vec![0.0; 12]);
  }

  let segment_baseline = engine
    .capture_decode_apply_baseline(DeckId::Top, "full.mp3", 4, false)
    .unwrap();
  let full_prepared = prepare_decoded_audio(None, vec![1.0; 40], 4, 1, 0.0, true);
  assert!(engine.apply_prepared_decoded_audio(DeckId::Top, "full.mp3", 9, full_prepared, true));

  let stale_segment = prepare_decoded_audio(Some(segment_baseline), vec![2.0; 8], 4, 1, 6.0, false);
  assert!(!engine.apply_prepared_decoded_audio(DeckId::Top, "full.mp3", 4, stale_segment, false));

  let snapshot = engine.snapshot(1000.0);
  assert!(snapshot.top.loaded);
  assert!(snapshot.top.fully_decoded);
  assert!(snapshot.top.playhead_loaded);
  assert!(!snapshot.top.decoding);
  assert_eq!(
    engine.deck(DeckId::Top).fully_decoded_file_path.as_deref(),
    Some("full.mp3")
  );
  assert_eq!(engine.deck(DeckId::Top).pcm_data.len(), 40);
}

#[test]
fn prepare_full_decode_request_waits_until_bootstrap_segment_is_loaded() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("load.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 0.0;
  }

  let bootstrap = engine.prepare_decode_request(DeckId::Top);
  let full = engine.prepare_full_decode_request(DeckId::Top);

  assert!(bootstrap.is_some());
  assert!(full.is_none());
  let bootstrap = bootstrap.unwrap();
  assert!(!bootstrap.is_full_decode);
  assert_eq!(bootstrap.start_sec, 0.0);
  assert_eq!(
    bootstrap.max_duration_sec,
    Some(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC)
  );
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    Some("load.mp3")
  );
  assert_eq!(
    engine
      .deck(DeckId::Top)
      .pending_full_decode_file_path
      .as_deref(),
    None
  );

  let prepared = prepare_decoded_audio(None, vec![0.0; 12], 4, 1, bootstrap.start_sec, false);
  assert!(engine.apply_prepared_decoded_audio(
    DeckId::Top,
    "load.mp3",
    bootstrap.request_id,
    prepared,
    false
  ));

  let full = engine.prepare_full_decode_request(DeckId::Top);
  assert!(full.is_some());
  let full = full.unwrap();
  assert!(full.is_full_decode);
  assert_eq!(full.max_duration_sec, None);
  assert_eq!(
    engine
      .deck(DeckId::Top)
      .pending_full_decode_file_path
      .as_deref(),
    Some("load.mp3")
  );
}

#[test]
fn startup_decode_covers_current_playhead_when_cue_is_after_startup_block() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("late-cue.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 12.5;
  }

  let bootstrap = engine.prepare_decode_request(DeckId::Top);

  assert!(bootstrap.is_some());
  let bootstrap = bootstrap.unwrap();
  assert!(!bootstrap.is_full_decode);
  assert!((bootstrap.start_sec - 12.25).abs() < 0.0001);
  assert_eq!(
    bootstrap.max_duration_sec,
    Some(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC)
  );
}

#[test]
fn prepare_playhead_decode_request_reuses_pending_startup_decode_covering_playhead() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("playhead.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 0.16;
    top.time_basis_offset_ms = Some(25.0);
  }

  let pending = engine.prepare_decode_request(DeckId::Top).unwrap();
  assert_eq!(pending.request_id, 1);
  assert!(engine.prepare_decode_request(DeckId::Top).is_none());

  let playhead = engine.prepare_playhead_decode_request(DeckId::Top);
  assert!(playhead.is_none());
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 1);
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    Some("playhead.mp3")
  );
  assert!(engine
    .deck(DeckId::Top)
    .pending_decode_start_sec
    .is_some_and(|value| value.abs() < 0.0001));
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_max_duration_sec,
    Some(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC)
  );

  let prepared = prepare_decoded_audio(None, vec![0.0; 40], 4, 1, pending.start_sec, false);
  assert!(engine.apply_prepared_decoded_audio(
    DeckId::Top,
    "playhead.mp3",
    pending.request_id,
    prepared,
    false
  ));

  let snapshot = engine.snapshot(0.0);
  assert!(snapshot.top.loaded);
  assert!(snapshot.top.playhead_loaded);
  assert!(!snapshot.top.decoding);
}

#[test]
fn prepare_playhead_reuses_pending_startup_after_time_basis_offset_moves_playhead_back() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("offset-playhead.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 0.036057;
  }

  let pending = engine.prepare_decode_request(DeckId::Top).unwrap();
  assert_eq!(pending.request_id, 1);
  assert!(pending.start_sec.abs() < 0.0001);

  {
    let top = engine.deck_mut(DeckId::Top);
    top.time_basis_offset_ms = Some(25.057);
  }

  let playhead = engine.prepare_playhead_decode_request(DeckId::Top);
  assert!(playhead.is_none());
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 1);
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    Some("offset-playhead.mp3")
  );
}

#[test]
fn prepare_playhead_decode_request_replaces_pending_startup_decode_after_playhead_moves() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("playhead.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 0.16;
    top.time_basis_offset_ms = Some(25.0);
  }

  let pending = engine.prepare_decode_request(DeckId::Top).unwrap();
  assert_eq!(pending.request_id, 1);
  assert!(engine.prepare_decode_request(DeckId::Top).is_none());

  {
    let top = engine.deck_mut(DeckId::Top);
    top.current_sec = 20.0;
    top.last_observed_at_ms = 0.0;
  }

  let playhead = engine.prepare_playhead_decode_request(DeckId::Top).unwrap();
  assert_eq!(playhead.request_id, 2);
  assert!(!playhead.is_full_decode);
  assert!((playhead.start_sec - 19.725).abs() < 0.0001);
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    Some("playhead.mp3")
  );

  let stale = prepare_decoded_audio(None, vec![0.0; 40], 4, 1, pending.start_sec, false);
  assert!(!engine.apply_prepared_decoded_audio(
    DeckId::Top,
    "playhead.mp3",
    pending.request_id,
    stale,
    false
  ));

  let prepared = prepare_decoded_audio(None, vec![0.0; 40], 4, 1, playhead.start_sec, false);
  assert!(engine.apply_prepared_decoded_audio(
    DeckId::Top,
    "playhead.mp3",
    playhead.request_id,
    prepared,
    false
  ));

  let snapshot = engine.snapshot(0.0);
  assert!(snapshot.top.loaded);
  assert!(snapshot.top.playhead_loaded);
  assert!(!snapshot.top.decoding);
}

#[test]
fn startup_decode_refills_current_playhead_after_time_basis_offset_changes() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("offset-hydrated.mp3".to_string());
    top.loaded_file_path = Some("offset-hydrated.mp3".to_string());
    top.pending_full_decode_file_path = Some("offset-hydrated.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 0.033;
    top.time_basis_offset_ms = Some(25.0);
    top.sample_rate = 1000;
    top.channels = 1;
    top.pcm_start_sec = 0.033;
    top.pcm_data = Arc::new(vec![0.0; 10_000]);
  }

  let bootstrap = engine.prepare_decode_request(DeckId::Top);

  assert!(bootstrap.is_some());
  let bootstrap = bootstrap.unwrap();
  assert!(!bootstrap.is_full_decode);
  assert!(bootstrap.start_sec.abs() < 0.0001);
  assert_eq!(
    engine
      .deck(DeckId::Top)
      .pending_full_decode_file_path
      .as_deref(),
    Some("offset-hydrated.mp3")
  );

  let prepared =
    prepare_decoded_audio(None, vec![0.0; 10_000], 1000, 1, bootstrap.start_sec, false);
  assert!(engine.apply_prepared_decoded_audio(
    DeckId::Top,
    "offset-hydrated.mp3",
    bootstrap.request_id,
    prepared,
    false
  ));

  let snapshot = engine.snapshot(0.0);
  assert!(snapshot.top.playhead_loaded);
  assert_eq!(
    engine
      .deck(DeckId::Top)
      .pending_full_decode_file_path
      .as_deref(),
    Some("offset-hydrated.mp3")
  );
}

#[test]
fn startup_decode_can_fill_current_playhead_while_full_decode_is_pending() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("full-pending.mp3".to_string());
    top.loaded_file_path = Some("full-pending.mp3".to_string());
    top.pending_full_decode_file_path = Some("full-pending.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 42.0;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; HORIZONTAL_BROWSE_STARTUP_DECODE_SEC as usize * 4]);
  }

  let bootstrap = engine.prepare_decode_request(DeckId::Top);

  assert!(bootstrap.is_some());
  let bootstrap = bootstrap.unwrap();
  assert!(!bootstrap.is_full_decode);
  assert!((bootstrap.start_sec - 41.75).abs() < 0.0001);
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 1);
  assert_eq!(
    engine
      .deck(DeckId::Top)
      .pending_full_decode_file_path
      .as_deref(),
    Some("full-pending.mp3")
  );
}

#[test]
fn seek_outside_startup_block_does_not_request_stream_decode() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("startup.mp3".to_string());
    top.loaded_file_path = Some("startup.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 4.2;
    top.playing = true;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; HORIZONTAL_BROWSE_STARTUP_DECODE_SEC as usize * 4]);
    top.decode_request_id = 11;
  }

  engine.seek(DeckId::Top, 1500.0, 42.0);

  assert_eq!(engine.deck(DeckId::Top).current_sec, 42.0);
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 11);
  assert_eq!(engine.deck(DeckId::Top).pending_decode_file_path, None);
}
