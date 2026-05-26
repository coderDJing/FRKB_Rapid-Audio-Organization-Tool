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

fn adjusted_grid_offset_sec(engine: &HorizontalBrowseTransportEngine, deck: DeckId) -> f64 {
  let grid = engine.beat_grid(deck).unwrap();
  HorizontalBrowseTransportEngine::nearest_grid_offset_sec(grid, engine.deck(deck).current_sec)
}

fn playback_scaled_grid_offset_sec(engine: &HorizontalBrowseTransportEngine, deck: DeckId) -> f64 {
  let rate =
    HorizontalBrowseTransportEngine::normalize_playback_rate(engine.deck(deck).playback_rate);
  adjusted_grid_offset_sec(engine, deck) / rate
}

fn setup_full_sync_grid_shift_engine() -> HorizontalBrowseTransportEngine {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(128.0);
    top.first_beat_ms = Some(20.0);
    top.duration_sec = 120.0;
    top.current_sec = 10.25;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 120);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(128.0);
    bottom.first_beat_ms = Some(45.0);
    bottom.duration_sec = 120.0;
    bottom.current_sec = 4.0;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 120);
  }
  engine.set_leader(Some(DeckId::Top));
  engine.beatsync(DeckId::Bottom);
  engine
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
fn negative_seek_survives_snapshot_and_advances_before_audio_start() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("lead-in.mp3".to_string());
    top.duration_sec = 20.0;
    top.current_sec = 0.0;
    top.last_observed_at_ms = 1000.0;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 20);
  }

  engine.seek(DeckId::Top, 1000.0, -0.75);
  engine.set_playing(DeckId::Top, 1000.0, true);
  let snapshot = engine.snapshot(1250.0);

  assert!((snapshot.top.current_sec + 0.5).abs() < 0.0001);
  assert!(!snapshot.top.playhead_loaded);
  assert!(!snapshot.top.playing_audible);
  assert!(snapshot.top.play_requested);
}

#[test]
fn negative_playhead_outputs_silence_until_zero_then_audio() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("lead-in.mp3".to_string());
    top.loaded_file_path = top.file_path.clone();
    top.duration_sec = 20.0;
    top.current_sec = -0.5;
    top.last_observed_at_ms = -1.0;
    top.playing = true;
    top.playback_rate = 1.0;
    top.master_tempo_enabled = false;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![1.0; 16]);
  }

  let (first, _) = engine.sample_deck(DeckId::Top);
  let (second, _) = engine.sample_deck(DeckId::Top);
  let (third, _) = engine.sample_deck(DeckId::Top);

  assert_eq!(first, (0.0, 0.0));
  assert_eq!(second, (0.0, 0.0));
  assert_eq!(third, (1.0, 1.0));
  assert!((engine.deck(DeckId::Top).current_sec - 0.25).abs() < 0.0001);
}

#[test]
fn fully_decoded_pcm_tail_stops_at_real_audio_end() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("tail.mp3".to_string());
    top.loaded_file_path = top.file_path.clone();
    top.fully_decoded_file_path = top.file_path.clone();
    top.duration_sec = 3.0;
    top.current_sec = 2.5;
    top.last_observed_at_ms = -1.0;
    top.playing = true;
    top.playback_rate = 1.0;
    top.master_tempo_enabled = false;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; 10]);
  }

  let (sample, _) = engine.sample_deck(DeckId::Top);
  let snapshot = engine.snapshot(1000.0);

  assert_eq!(sample, (0.0, 0.0));
  assert!(!engine.deck(DeckId::Top).playing);
  assert!((engine.deck(DeckId::Top).current_sec - 2.5).abs() < 0.0001);
  assert!(!snapshot.top.playing);
  assert!(!snapshot.top.play_requested);
  assert!((snapshot.top.current_sec - 2.5).abs() < 0.0001);
  assert!((snapshot.top.duration_sec - 3.0).abs() < 0.0001);
}

#[test]
fn partial_pcm_tail_does_not_stop_while_full_decode_is_pending() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("partial.mp3".to_string());
    top.loaded_file_path = top.file_path.clone();
    top.pending_full_decode_file_path = top.file_path.clone();
    top.duration_sec = 3.0;
    top.current_sec = 2.5;
    top.last_observed_at_ms = -1.0;
    top.playing = true;
    top.playback_rate = 1.0;
    top.master_tempo_enabled = false;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; 10]);
  }

  let (sample, _) = engine.sample_deck(DeckId::Top);

  assert_eq!(sample, (0.0, 0.0));
  assert!(engine.deck(DeckId::Top).playing);
  assert!((engine.deck(DeckId::Top).current_sec - 2.5).abs() < 0.0001);
}

#[test]
fn full_pcm_tail_clamps_snapshot_estimate_before_audio_callback_stops() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("tail-snapshot.mp3".to_string());
    top.loaded_file_path = top.file_path.clone();
    top.fully_decoded_file_path = top.file_path.clone();
    top.duration_sec = 3.0;
    top.current_sec = 2.4;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    top.sample_rate = 4;
    top.channels = 1;
    top.pcm_start_sec = 0.0;
    top.pcm_data = Arc::new(vec![0.0; 10]);
  }

  let snapshot = engine.snapshot(2000.0);

  assert!(engine.deck(DeckId::Top).playing);
  assert!((snapshot.top.current_sec - 2.5).abs() < 0.0001);
  assert!((snapshot.top.duration_sec - 3.0).abs() < 0.0001);
  assert!((snapshot.top.effective_duration_sec - 2.5).abs() < 0.0001);
  assert!(!snapshot.top.playing_audible);
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
fn external_same_file_state_does_not_rewind_playing_deck() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 2000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("a.mp3".to_string());
    top.title = Some("A".to_string());
    top.bpm = Some(128.0);
    top.duration_sec = 20.0;
    top.current_sec = 5.0;
    top.last_observed_at_ms = -1.0;
    top.playing = true;
    top.playback_rate = 1.25;
    top.master_tempo_enabled = true;
    install_loaded_test_pcm(top, 20);
  }

  engine.apply_external_deck_state(
    DeckId::Top,
    2200.0,
    HorizontalBrowseTransportDeckInput {
      file_path: Some("a.mp3".to_string()),
      title: Some("A".to_string()),
      bpm: Some(128.0),
      first_beat_ms: Some(0.0),
      bar_beat_offset: Some(0.0),
      time_basis_offset_ms: Some(0.0),
      duration_sec: 20.0,
      current_sec: 1.0,
      last_observed_at_ms: 1800.0,
      playing: true,
      playback_rate: 1.25,
      master_tempo_enabled: true,
    },
  );

  assert!((engine.deck(DeckId::Top).current_sec - 5.0).abs() < 0.0001);
  assert_eq!(engine.deck(DeckId::Top).last_observed_at_ms, 2200.0);
}

#[test]
fn master_tempo_and_rate_commands_preserve_audio_owned_playhead() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 3000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("a.mp3".to_string());
    top.title = Some("A".to_string());
    top.bpm = Some(128.0);
    top.duration_sec = 20.0;
    top.current_sec = 6.0;
    top.last_observed_at_ms = -1.0;
    top.playing = true;
    top.playback_rate = 1.2;
    top.master_tempo_enabled = true;
    install_loaded_test_pcm(top, 20);
  }

  engine.set_master_tempo_enabled(DeckId::Top, 3200.0, false);
  assert!((engine.deck(DeckId::Top).current_sec - 6.0).abs() < 0.0001);
  assert!(!engine.deck(DeckId::Top).master_tempo_enabled);

  {
    let top = engine.deck_mut(DeckId::Top);
    top.current_sec = 7.0;
    top.last_observed_at_ms = -1.0;
  }
  engine.set_playback_rate(DeckId::Top, 3400.0, 0.8);
  assert!((engine.deck(DeckId::Top).current_sec - 7.0).abs() < 0.0001);
  assert!((engine.deck(DeckId::Top).playback_rate - 0.8).abs() < 0.0001);
}

#[test]
fn tempo_nudge_rate_keeps_sync_tempo_only_without_phase_alignment() {
  let mut engine = setup_full_sync_grid_shift_engine();
  let expected_current =
    HorizontalBrowseTransportEngine::estimate_current_sec(engine.deck(DeckId::Bottom), 1200.0);

  engine.set_tempo_nudge_playback_rate(DeckId::Bottom, 1200.0, 0.98);
  let snapshot = engine.snapshot(1200.0);

  assert!(snapshot.bottom.sync_enabled);
  assert_eq!(snapshot.bottom.sync_lock, "tempo-only");
  assert!((engine.deck(DeckId::Bottom).playback_rate - 0.98).abs() < 0.0001);
  assert!((engine.deck(DeckId::Bottom).current_sec - expected_current).abs() < 0.0001);

  engine.set_tempo_nudge_playback_rate(DeckId::Bottom, 1300.0, 1.0);
  let restored_snapshot = engine.snapshot(1300.0);

  assert_eq!(restored_snapshot.bottom.sync_lock, "tempo-only");
  assert!((engine.deck(DeckId::Bottom).playback_rate - 1.0).abs() < 0.0001);
}

#[test]
fn tempo_nudge_leader_does_not_drag_follower_rate() {
  let mut engine = setup_full_sync_grid_shift_engine();
  engine.set_sync_enabled(DeckId::Top, true);
  let follower_rate_before = engine.deck(DeckId::Bottom).playback_rate;

  engine.set_tempo_nudge_playback_rate(DeckId::Top, 1200.0, 1.02);
  let snapshot = engine.snapshot(1200.0);

  assert!(snapshot.top.sync_enabled);
  assert_eq!(snapshot.top.sync_lock, "tempo-only");
  assert_eq!(snapshot.bottom.sync_lock, "full");
  assert!((engine.deck(DeckId::Top).playback_rate - 1.02).abs() < 0.0001);
  assert!((engine.deck(DeckId::Bottom).playback_rate - follower_rate_before).abs() < 0.0001);
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
  engine.align_to_leader(DeckId::Bottom, Some(requested_target_sec), false);

  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
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
fn set_playing_keeps_pending_startup_decode() {
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

  engine.set_playing(DeckId::Top, 1200.0, true);

  assert!(engine.deck(DeckId::Top).playing);
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    Some("pending.mp3")
  );
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 7);
}

#[test]
fn set_playing_does_not_start_seek_segment_while_full_decode_is_pending() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("pending-full.mp3".to_string());
    top.pending_full_decode_file_path = Some("pending-full.mp3".to_string());
    top.duration_sec = 60.0;
    top.current_sec = 12.0;
    top.last_observed_at_ms = 1000.0;
    top.decode_request_id = 7;
    top.full_decode_request_id = 3;
  }

  engine.set_playing(DeckId::Top, 1200.0, true);

  assert!(engine.deck(DeckId::Top).playing);
  assert_eq!(engine.deck(DeckId::Top).decode_request_id, 7);
  assert_eq!(
    engine.deck(DeckId::Top).pending_decode_file_path.as_deref(),
    None
  );
  assert_eq!(
    engine
      .deck(DeckId::Top)
      .pending_full_decode_file_path
      .as_deref(),
    Some("pending-full.mp3")
  );
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

  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
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
  engine.align_to_leader(DeckId::Bottom, Some(requested_target_sec), false);

  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - requested_target_sec).abs();

  assert!((engine.deck(DeckId::Top).current_sec - leader_before).abs() < 0.0001);
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
}

#[test]
fn align_to_leader_preserves_negative_requested_anchor() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(120.0);
    top.first_beat_ms = Some(0.0);
    top.duration_sec = 60.0;
    top.current_sec = 10.1;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(120.0);
    bottom.first_beat_ms = Some(0.0);
    bottom.duration_sec = 60.0;
    bottom.current_sec = -1.2;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 60);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.set_sync_enabled(DeckId::Top, true);
  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.align_to_leader(DeckId::Bottom, Some(-1.2), false);

  let follower_grid = engine.original_beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - (-1.2)).abs();

  assert!(engine.deck(DeckId::Bottom).current_sec < 0.0);
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
}

#[test]
fn set_playing_keeps_link_sync_lock_during_negative_silent_lead_in() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(141.0);
    top.first_beat_ms = Some(61.089);
    top.duration_sec = 60.0;
    top.current_sec = 10.6;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(135.0);
    bottom.first_beat_ms = Some(71.057);
    bottom.duration_sec = 60.0;
    bottom.current_sec = -3.012_880_824;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 60);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.set_sync_enabled(DeckId::Top, true);
  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.align_to_leader(DeckId::Bottom, Some(-3.012_880_824), false);
  engine.set_playing(DeckId::Bottom, 1010.0, true);

  let negative_snapshot = engine.snapshot(1010.0);
  assert_eq!(negative_snapshot.bottom.sync_lock, "full");
  assert!(negative_snapshot.bottom.current_sec < 0.0);
  assert!(!negative_snapshot.bottom.playhead_loaded);
  assert!(!negative_snapshot.bottom.playing_audible);

  let audible_snapshot = engine.snapshot(4300.0);
  assert_eq!(audible_snapshot.bottom.sync_lock, "full");
  assert!(audible_snapshot.bottom.current_sec > 0.0);
  assert!(audible_snapshot.bottom.playhead_loaded);
  assert!(audible_snapshot.bottom.playing_audible);
}

#[test]
fn linked_negative_lead_in_audio_crosses_zero_without_phase_jump() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(141.0);
    top.first_beat_ms = Some(61.089);
    top.duration_sec = 60.0;
    top.current_sec = 10.6;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    top.master_tempo_enabled = false;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(135.0);
    bottom.first_beat_ms = Some(71.057);
    bottom.duration_sec = 60.0;
    bottom.current_sec = -0.75;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    bottom.master_tempo_enabled = false;
    bottom.sample_rate = 4;
    bottom.channels = 1;
    bottom.pcm_start_sec = 0.0;
    bottom.pcm_data = Arc::new(vec![1.0; 240]);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.set_sync_enabled(DeckId::Top, true);
  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.align_to_leader(DeckId::Bottom, Some(-0.75), false);
  engine.set_playing(DeckId::Bottom, 1010.0, true);

  let leader_offset_before = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset_before = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
  assert!(engine.deck(DeckId::Bottom).current_sec < 0.0);
  assert!((leader_offset_before - follower_offset_before).abs() < 0.0001);

  let mut heard_bottom_audio = false;
  for _ in 0..16 {
    let bottom_before_sec = engine.deck(DeckId::Bottom).current_sec;
    let output = engine.mix_output_frame();
    if output.0.abs() > 0.0001 || output.1.abs() > 0.0001 {
      heard_bottom_audio = true;
      assert!(bottom_before_sec >= 0.0);
    }
  }

  let snapshot = engine.snapshot(5000.0);
  let leader_offset_after = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset_after = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
  assert!(heard_bottom_audio);
  assert_eq!(snapshot.bottom.sync_lock, "full");
  assert!(snapshot.bottom.current_sec > 0.0);
  assert!(snapshot.bottom.playing_audible);
  assert!((leader_offset_after - follower_offset_after).abs() < 0.0001);
}

#[test]
fn align_to_leader_with_multiplier_aligns_rendered_grid() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(120.0);
    top.first_beat_ms = Some(0.0);
    top.duration_sec = 60.0;
    top.current_sec = 10.1;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 60);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(60.0);
    bottom.first_beat_ms = Some(0.0);
    bottom.duration_sec = 60.0;
    bottom.current_sec = -1.2;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = false;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 60);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.set_sync_enabled(DeckId::Top, true);
  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.align_to_leader(DeckId::Bottom, Some(-1.2), false);

  let follower_grid = engine.beat_grid(DeckId::Bottom).unwrap();
  let leader_offset = adjusted_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = adjusted_grid_offset_sec(&engine, DeckId::Bottom);
  let nearest_delta_sec = (engine.deck(DeckId::Bottom).current_sec - (-1.2)).abs();

  assert!(
    (engine.bpm_multiplier[HorizontalBrowseTransportEngine::deck_index(DeckId::Bottom)] - 2.0)
      .abs()
      < 0.0001
  );
  assert!(engine.deck(DeckId::Bottom).current_sec < 0.0);
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(nearest_delta_sec <= follower_grid.beat_sec * 0.5 + 0.0001);
}

#[test]
fn align_to_leader_skip_grid_snap_preserves_position_and_sets_rate() {
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
  let position_before = engine.deck(DeckId::Bottom).current_sec;
  engine.align_to_leader(DeckId::Bottom, Some(position_before), true);

  let snap = engine.snapshot(1000.0);
  assert!((engine.deck(DeckId::Bottom).current_sec - position_before).abs() < 0.0001);
  assert!(snap.bottom.sync_enabled, "sync should be enabled");
  assert!(
    (snap.bottom.playback_rate - 1.0).abs() < 0.001,
    "expected playback_rate ~1.0 (BPM already matched via multiplier), got {}",
    snap.bottom.playback_rate
  );
}

#[test]
fn set_beat_grid_preserves_follower_full_sync_with_phase_compensation() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(128.0);
    top.first_beat_ms = Some(20.0);
    top.duration_sec = 120.0;
    top.current_sec = 10.25;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 120);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(128.0);
    bottom.first_beat_ms = Some(45.0);
    bottom.duration_sec = 120.0;
    bottom.current_sec = 4.0;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 120);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.beatsync(DeckId::Bottom);
  let previous_current_sec = engine.deck(DeckId::Bottom).current_sec;
  let previous_first_beat_ms = engine.deck(DeckId::Bottom).first_beat_ms.unwrap();

  engine.set_beat_grid(
    DeckId::Bottom,
    None,
    Some(previous_first_beat_ms + 5.0),
    None,
    None,
  );

  let snapshot = engine.snapshot(1000.0);
  let leader_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);
  assert!(snapshot.bottom.sync_enabled);
  assert_eq!(snapshot.bottom.sync_lock, "full");
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!((engine.deck(DeckId::Bottom).current_sec - previous_current_sec - 0.005).abs() < 0.0001);
}

#[test]
fn set_beat_grid_preserves_leader_full_sync_with_phase_compensation() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(128.0);
    top.first_beat_ms = Some(20.0);
    top.duration_sec = 120.0;
    top.current_sec = 10.25;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 120);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(128.0);
    bottom.first_beat_ms = Some(45.0);
    bottom.duration_sec = 120.0;
    bottom.current_sec = 4.0;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 120);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.beatsync(DeckId::Bottom);
  let previous_leader_current_sec = engine.deck(DeckId::Top).current_sec;
  let previous_follower_current_sec = engine.deck(DeckId::Bottom).current_sec;
  let previous_first_beat_ms = engine.deck(DeckId::Top).first_beat_ms.unwrap();

  engine.set_beat_grid(
    DeckId::Top,
    None,
    Some(previous_first_beat_ms + 20.0),
    None,
    None,
  );

  let snapshot = engine.snapshot(1000.0);
  let leader_offset = visual_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = visual_grid_offset_sec(&engine, DeckId::Bottom);
  assert!(snapshot.bottom.sync_enabled);
  assert_eq!(snapshot.bottom.sync_lock, "full");
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!(
    (engine.deck(DeckId::Top).current_sec - previous_leader_current_sec - 0.020).abs() < 0.0001
  );
  assert!((engine.deck(DeckId::Bottom).current_sec - previous_follower_current_sec).abs() < 0.0001);
}

#[test]
fn set_beat_grid_preserves_link_button_sync_with_phase_compensation() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  {
    let top = engine.deck_mut(DeckId::Top);
    top.file_path = Some("leader.mp3".to_string());
    top.loaded_file_path = Some("leader.mp3".to_string());
    top.bpm = Some(128.0);
    top.first_beat_ms = Some(20.0);
    top.duration_sec = 120.0;
    top.current_sec = 10.25;
    top.last_observed_at_ms = 1000.0;
    top.playing = true;
    top.playback_rate = 1.0;
    install_loaded_test_pcm(top, 120);
  }
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.file_path = Some("follower.mp3".to_string());
    bottom.loaded_file_path = Some("follower.mp3".to_string());
    bottom.bpm = Some(128.0);
    bottom.first_beat_ms = Some(45.0);
    bottom.duration_sec = 120.0;
    bottom.current_sec = 4.0;
    bottom.last_observed_at_ms = 1000.0;
    bottom.playing = true;
    bottom.playback_rate = 1.0;
    install_loaded_test_pcm(bottom, 120);
  }

  engine.set_leader(Some(DeckId::Top));
  engine.set_sync_enabled(DeckId::Top, true);
  engine.set_sync_enabled(DeckId::Bottom, true);
  engine.align_to_leader(DeckId::Bottom, Some(4.0), false);
  let previous_current_sec = engine.deck(DeckId::Bottom).current_sec;
  let previous_first_beat_ms = engine.deck(DeckId::Bottom).first_beat_ms.unwrap();

  engine.set_beat_grid(
    DeckId::Bottom,
    None,
    Some(previous_first_beat_ms + 5.0),
    None,
    None,
  );

  let snapshot = engine.snapshot(1000.0);
  let leader_offset = visual_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = visual_grid_offset_sec(&engine, DeckId::Bottom);
  assert!(snapshot.top.sync_enabled);
  assert!(snapshot.bottom.sync_enabled);
  assert_eq!(snapshot.bottom.sync_lock, "full");
  assert!((leader_offset - follower_offset).abs() < 0.0001);
  assert!((engine.deck(DeckId::Bottom).current_sec - previous_current_sec - 0.005).abs() < 0.0001);
}

#[test]
fn set_beat_grid_same_values_does_not_reapply_phase_compensation() {
  let mut engine = setup_full_sync_grid_shift_engine();
  let previous_current_sec = engine.deck(DeckId::Bottom).current_sec;
  let next_first_beat_ms = engine.deck(DeckId::Bottom).first_beat_ms.unwrap() + 5.0;

  engine.set_beat_grid(DeckId::Bottom, None, Some(next_first_beat_ms), None, None);
  let shifted_current_sec = engine.deck(DeckId::Bottom).current_sec;
  engine.set_beat_grid(DeckId::Bottom, None, Some(next_first_beat_ms), None, None);

  assert!((shifted_current_sec - previous_current_sec - 0.005).abs() < 0.0001);
  assert!((engine.deck(DeckId::Bottom).current_sec - shifted_current_sec).abs() < 0.0001);
}

#[test]
fn set_beat_grid_phase_compensation_resets_audio_owned_playhead() {
  let mut engine = setup_full_sync_grid_shift_engine();
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.master_tempo_enabled = true;
    bottom.playback_rate = 1.1;
  }
  let _ = engine.sample_deck(DeckId::Bottom);
  let next_first_beat_ms = engine.deck(DeckId::Bottom).first_beat_ms.unwrap() + 5.0;

  engine.set_beat_grid(DeckId::Bottom, None, Some(next_first_beat_ms), None, None);
  let shifted_current_sec = engine.deck(DeckId::Bottom).current_sec;
  let _ = engine.sample_deck(DeckId::Bottom);

  let advanced_sec = engine.deck(DeckId::Bottom).current_sec - shifted_current_sec;
  assert!(advanced_sec >= 0.0);
  assert!(advanced_sec < 0.001);
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

  let leader_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Top);
  let follower_offset = playback_scaled_grid_offset_sec(&engine, DeckId::Bottom);

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
