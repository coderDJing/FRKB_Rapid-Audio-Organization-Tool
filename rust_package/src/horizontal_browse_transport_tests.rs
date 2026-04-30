use std::sync::Arc;

use super::*;

fn install_loaded_test_pcm(deck: &mut DeckState, seconds: usize) {
  deck.loaded_file_path = deck.file_path.clone();
  deck.sample_rate = 4;
  deck.channels = 1;
  deck.pcm_start_sec = 0.0;
  deck.pcm_data = Arc::new(vec![0.0; seconds.saturating_mul(4).max(1)]);
}

fn visual_grid_offset_sec(engine: &HorizontalBrowseTransportEngine, deck: DeckId) -> f64 {
  let grid = engine.original_beat_grid(deck).unwrap();
  HorizontalBrowseTransportEngine::nearest_grid_offset_sec(grid, engine.deck(deck).current_sec)
}

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
    install_loaded_test_pcm(top, 20);
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
    install_loaded_test_pcm(bottom, 20);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.beatsync(DeckId::Bottom);

  let snapshot = engine.snapshot(1000.0);
  let top_grid = engine.beat_grid(DeckId::Top).unwrap();
  let bottom_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let top_distance =
    (engine.deck(DeckId::Top).current_sec - top_grid.first_beat_sec) / top_grid.beat_sec;
  let bottom_distance =
    (engine.deck(DeckId::Bottom).current_sec - bottom_grid.first_beat_sec) / bottom_grid.beat_sec;
  let phase_delta = (top_distance - bottom_distance).rem_euclid(1.0);

  assert!(phase_delta < 0.0001 || (1.0 - phase_delta) < 0.0001);
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
    install_loaded_test_pcm(top, 20);
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
fn playing_audible_requires_loaded_segment_covering_playhead() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("a.mp3".to_string());
    top.duration_sec = 20.0;
    top.current_sec = 0.5;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
  }

  let decoding_snapshot = engine.snapshot(1200.0);
  assert!(decoding_snapshot.top.playing);
  assert!(decoding_snapshot.top.play_requested);
  assert!(!decoding_snapshot.top.playing_audible);
  assert!(!decoding_snapshot.top.playhead_loaded);
  assert!((decoding_snapshot.top.current_sec - 0.5).abs() < 0.0001);

  {
    let top = engine.deck_mut(DeckId::Top);
    top.loaded_file_path = Some("a.mp3".to_string());
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; 12]);
  }
  let loaded_snapshot = engine.snapshot(1200.0);
  assert!(loaded_snapshot.top.playhead_loaded);
  assert!(loaded_snapshot.top.playing_audible);
  assert!(loaded_snapshot.top.current_sec > 0.5);
}

#[test]
fn sync_ignores_play_requested_deck_until_audio_is_ready() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.bpm = Some(133.0);
    top.first_beat_ms = Some(0.0);
    top.duration_sec = 120.0;
    top.current_sec = 0.0;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(136.0);
    bottom.first_beat_ms = Some(46.0);
    bottom.duration_sec = 120.0;
    bottom.current_sec = 0.0;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
  }

  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.beatsync(DeckId::Bottom);

  let snapshot = engine.snapshot(1000.0);
  assert!(snapshot.top.play_requested);
  assert!(!snapshot.top.playing_audible);
  assert!(snapshot.bottom.play_requested);
  assert!(!snapshot.bottom.playing_audible);
  assert_eq!(snapshot.leader_deck, None);
  assert_eq!(snapshot.bottom.sync_lock, "off");
  assert!((snapshot.bottom.current_sec - 0.0).abs() < 0.0001);
}

#[test]
fn sync_resumes_after_audio_becomes_ready() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(133.0);
    top.first_beat_ms = Some(0.0);
    top.duration_sec = 120.0;
    top.current_sec = 4.0;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    install_loaded_test_pcm(top, 8);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(136.0);
    bottom.first_beat_ms = Some(46.0);
    bottom.duration_sec = 120.0;
    bottom.current_sec = 0.0;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    install_loaded_test_pcm(bottom, 8);
  }

  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.beatsync(DeckId::Bottom);

  let snapshot = engine.snapshot(1000.0);
  assert_eq!(snapshot.leader_deck.as_deref(), Some("top"));
  assert_eq!(snapshot.bottom.sync_lock, "full");
  assert!(snapshot.bottom.current_sec > 0.0);
}

#[test]
fn set_sync_enabled_does_not_phase_align_playhead() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.bpm = Some(133.0);
    top.first_beat_ms = Some(49.0);
    top.duration_sec = 60.0;
    top.current_sec = 6.37;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(136.0);
    bottom.first_beat_ms = Some(94.0);
    bottom.duration_sec = 60.0;
    bottom.current_sec = 2.61;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 60);
  }

  engine.set_leader(Some(DeckId::Top));
  let before = engine.deck(DeckId::Bottom).current_sec;
  engine.set_sync_enabled(DeckId::Bottom, true);

  assert!((engine.deck(DeckId::Bottom).current_sec - before).abs() < 0.0001);
  assert_eq!(
    engine.sync_lock[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)],
    "full"
  );
  assert!(engine.deck(DeckId::Bottom).playback_rate < 1.0);
}

#[test]
fn align_to_leader_uses_requested_anchor_for_nearest_visible_grid_line() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 2000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.bpm = Some(133.0);
    top.first_beat_ms = Some(49.0);
    top.duration_sec = 60.0;
    top.current_sec = 6.37;
    top.last_observed_at_ms = 2000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(136.0);
    bottom.first_beat_ms = Some(94.0);
    bottom.duration_sec = 60.0;
    bottom.current_sec = 1.15;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    bottom.playback_rate = 0.978;
    install_loaded_test_pcm(bottom, 60);
  }

  engine.set_leader(Some(DeckId::Top));
  let requested_target_sec = 2.757;
  engine.align_to_leader(DeckId::Bottom, Some(requested_target_sec));

  let follower_grid = engine.original_beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = visual_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = visual_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - requested_target_sec).abs();

  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
}

#[test]
fn snapshot_sequence_advances_without_state_revision_change() {
  let engine = HorizontalBrowseTransportEngine::default();
  let first = engine.snapshot(1000.0);
  let second = engine.snapshot(1001.0);

  assert!(second.snapshot_sequence > first.snapshot_sequence);
  assert_eq!(second.state_revision, first.state_revision);
}

#[test]
fn set_playing_reuses_pending_decode_for_current_file() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("pending.mp3".to_string());
    top.pending_decode_file_path = Some("pending.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 0.0;
    top.last_observed_at_ms = 1000.0;
    top.decode_request_id = 7;
  }

  let request = engine.set_playing(DeckId::Top, 1200.0, true);

  assert!(request.is_none());
  assert!(engine.deck(DeckId::Top).playing);
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    Some("pending.mp3")
  );
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 7);
}

#[test]
fn beatsync_with_multiplier_snaps_to_nearest_visible_grid_line() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.bpm = Some(140.0);
    top.first_beat_ms = Some(0.0);
    top.duration_sec = 60.0;
    top.current_sec = 10.32;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(70.0);
    bottom.first_beat_ms = Some(0.0);
    bottom.duration_sec = 60.0;
    bottom.current_sec = 3.14;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
  }

  engine.set_leader(Some(DeckId::Top));
  engine.beatsync(DeckId::Bottom);

  let follower_grid = engine.original_beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = visual_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = visual_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - 3.14).abs();

  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
  assert!(
    (engine.bpm_multiplier[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)] - 2.0)
      .abs()
      < 0.0001
  );
}

#[test]
fn align_to_leader_snaps_requested_deck_to_nearest_leader_beat_grid_line() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(140.0);
    top.first_beat_ms = Some(20.0);
    top.bar_beat_offset = Some(8.0);
    top.duration_sec = 240.0;
    top.current_sec = 15.36;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 240);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(70.0);
    bottom.first_beat_ms = Some(110.0);
    bottom.bar_beat_offset = Some(0.0);
    bottom.duration_sec = 382.0;
    bottom.current_sec = 142.867;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 382);
  }

  engine.set_leader(Some(DeckId::Top));
  let leader_before = engine.deck(DeckId::Top).current_sec;
  let requested_target_sec = 142.867;
  engine.align_to_leader(DeckId::Bottom, Some(requested_target_sec));

  let follower_grid = engine.original_beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = visual_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = visual_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - requested_target_sec).abs();

  assert!((engine.deck(DeckId::Top).current_sec - leader_before).abs() < 0.0001);
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
}

#[test]
fn beatsync_near_track_start_keeps_nearest_valid_grid_line() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.bpm = Some(135.0);
    top.first_beat_ms = Some(75.465);
    top.duration_sec = 60.0;
    top.current_sec = 4.85;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(142.0);
    bottom.first_beat_ms = Some(63.855);
    bottom.duration_sec = 60.0;
    bottom.current_sec = 0.063855;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 0.950704;
  }

  engine.set_leader(Some(DeckId::Top));
  engine.bpm_multiplier[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)] = 1.0;
  engine.beatsync(DeckId::Bottom);

  let leader_offset = visual_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = visual_grid_offset_sec(&engine, DeckId::Bottom);

  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(engine.deck(DeckId::Bottom).current_sec >= 0.0);
  assert!(engine.deck(DeckId::Bottom).current_sec > 0.05);
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

#[test]
fn apply_decoded_audio_merges_overlapping_partial_segment() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("merge.mp3".to_string());
    top.loaded_file_path = Some("merge.mp3".to_string());
    top.decode_request_id = 1;
    top.current_sec = 1.5;
    top.pcm_start_sec = 0.0;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_data = Arc::new((0..16).map(|value| value as f32).collect::<Vec<f32>>());
  }

  let next_segment = (100..116).map(|value| value as f32).collect::<Vec<f32>>();
  let baseline = engine
    .capture_decode_merge_baseline(DeckId::Top, "merge.mp3", 1, false)
    .unwrap();
  let prepared = prepare_decoded_audio(Some(baseline), next_segment, 4, 1, 2.0, false);
  assert!(engine.apply_prepared_decoded_audio(DeckId::Top, "merge.mp3", 1, prepared, false));

  let top = engine.deck(DeckId::Top);
  assert_eq!(top.pcm_start_sec, 0.0);
  assert_eq!(top.pcm_data.len(), 24);
  assert_eq!(
    top.pcm_data[..16],
    [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0,]
  );
  assert_eq!(
    top.pcm_data[16..],
    [108.0, 109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0,]
  );
}

#[test]
fn apply_decoded_audio_replaces_disjoint_partial_segment() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("seek.mp3".to_string());
    top.loaded_file_path = Some("seek.mp3".to_string());
    top.decode_request_id = 2;
    top.current_sec = 12.0;
    top.pcm_start_sec = 0.0;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_data = Arc::new((0..16).map(|value| value as f32).collect::<Vec<f32>>());
  }

  let seek_segment = vec![10.0, 11.0, 12.0, 13.0];
  let baseline = engine
    .capture_decode_merge_baseline(DeckId::Top, "seek.mp3", 2, false)
    .unwrap();
  let prepared = prepare_decoded_audio(Some(baseline), seek_segment, 4, 1, 10.0, false);
  assert!(engine.apply_prepared_decoded_audio(DeckId::Top, "seek.mp3", 2, prepared, false));

  let top = engine.deck(DeckId::Top);
  assert_eq!(top.pcm_start_sec, 10.0);
  assert_eq!(top.pcm_data.as_ref().as_slice(), [10.0, 11.0, 12.0, 13.0]);
}

#[test]
fn followup_prefetch_allows_overlap_inside_loaded_segment() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("prefetch.mp3".to_string());
    top.loaded_file_path = Some("prefetch.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 4.2;
    top.playing = true;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; 12 * 4]);
  }

  let request = engine.maybe_prepare_followup_segment_decode_request(DeckId::Top);
  assert!(request.is_some());
  let request = request.unwrap();
  assert_eq!(request.deck, DeckId::Top);
  assert_eq!(request.file_path, "prefetch.mp3");
  assert!((request.start_sec - 8.0).abs() < 0.0001);
  assert_eq!(
    request.max_duration_sec,
    Some(HORIZONTAL_BROWSE_ASYNC_SEGMENT_DECODE_SEC)
  );
}
