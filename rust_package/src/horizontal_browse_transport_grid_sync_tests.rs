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
