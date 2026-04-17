use std::sync::Arc;

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
    top.sample_rate = 44100;
    top.channels = 2;
    top.pcm_data = Arc::new(vec![0.0, 0.0, 0.0, 0.0]);
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
    bottom.sample_rate = 44100;
    bottom.channels = 2;
    bottom.pcm_data = Arc::new(vec![0.0, 0.0, 0.0, 0.0]);
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
    top.sample_rate = 44100;
    top.channels = 2;
    top.pcm_data = Arc::new(vec![0.0, 0.0, 0.0, 0.0]);
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
fn beatsync_with_multiplier_snaps_to_nearest_phase_aligned_beat() {
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
    top.sample_rate = 44100;
    top.channels = 2;
    top.pcm_data = Arc::new(vec![0.0, 0.0, 0.0, 0.0]);
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

  let leader_grid = engine.beat_grid(DeckId::Top).unwrap();
  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_distance =
    (engine.deck(DeckId::Top).current_sec - leader_grid.first_beat_sec) / leader_grid.beat_sec;
  let follower_distance = (engine.deck(DeckId::Bottom).current_sec - follower_grid.first_beat_sec)
    / follower_grid.beat_sec;
  let original_follower_distance = 3.14 / follower_grid.beat_sec;
  let phase_delta = (leader_distance - follower_distance).rem_euclid(1.0);
  let nearest_delta = (follower_distance - original_follower_distance).abs();

  assert!(phase_delta < 0.0001 || (1.0 - phase_delta) < 0.0001);
  assert!(nearest_delta <= 0.5 + 0.0001);
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
    top.sample_rate = 44100;
    top.channels = 2;
    top.pcm_data = Arc::new(vec![0.0, 0.0, 0.0, 0.0]);
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

  let leader_grid = engine.beat_grid(DeckId::Top).unwrap();
  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_distance =
    (engine.deck(DeckId::Top).current_sec - leader_grid.first_beat_sec) / leader_grid.beat_sec;
  let follower_distance = (engine.deck(DeckId::Bottom).current_sec - follower_grid.first_beat_sec)
    / follower_grid.beat_sec;
  let phase_delta = (leader_distance - follower_distance).rem_euclid(1.0);

  assert!(phase_delta < 0.0001 || (1.0 - phase_delta) < 0.0001);
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
