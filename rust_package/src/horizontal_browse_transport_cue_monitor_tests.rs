use std::fs;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

fn install_constant_deck(engine: &mut HorizontalBrowseTransportEngine, deck: DeckId, value: f32) {
  let file_name = format!("{}-cue-monitor.wav", deck.as_str());
  let target = engine.deck_mut(deck);
  target.file_path = Some(file_name.clone());
  target.loaded_file_path = Some(file_name.clone());
  target.fully_decoded_file_path = Some(file_name);
  target.sample_rate = 4;
  target.channels = 1;
  target.pcm_start_sec = 0.0;
  target.pcm_data = Arc::new(vec![value; 16]);
  target.duration_sec = 4.0;
  target.current_sec = 0.0;
  target.last_observed_at_ms = 1000.0;
  target.playing = true;
  target.playback_rate = 1.0;
}

fn temp_recording_path(name: &str) -> std::path::PathBuf {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  std::env::temp_dir().join(format!(
    "frkb-{}-{}-{}.wav",
    name,
    std::process::id(),
    nanos
  ))
}

fn read_first_recorded_frame(path: &std::path::Path) -> (f32, f32) {
  let bytes = fs::read(path).expect("recording wav should be readable");
  assert!(bytes.len() >= 52);
  let left = f32::from_le_bytes(bytes[44..48].try_into().unwrap());
  let right = f32::from_le_bytes(bytes[48..52].try_into().unwrap());
  (left, right)
}

#[test]
fn cue_monitor_adds_equal_audible_copy_that_bypasses_crossfader() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  install_constant_deck(&mut engine, DeckId::Top, 0.25);
  engine.set_output_state(-1.0, 1.0);

  let muted_output = engine.mix_output_frame();
  assert!(muted_output.0.abs() < 0.0001);
  assert!(muted_output.1.abs() < 0.0001);

  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  install_constant_deck(&mut engine, DeckId::Top, 0.25);
  engine.set_output_state(-1.0, 1.0);
  engine.set_cue_monitor_enabled(DeckId::Top, true);

  let monitored_output = engine.mix_output_frame();
  assert!((monitored_output.0 - 0.25).abs() < 0.0001);
  assert!((monitored_output.1 - 0.25).abs() < 0.0001);

  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  install_constant_deck(&mut engine, DeckId::Top, 0.25);
  engine.set_output_state(0.0, 1.0);
  engine.set_cue_monitor_enabled(DeckId::Top, true);

  let stacked_output = engine.mix_output_frame();
  assert!((stacked_output.0 - 0.5).abs() < 0.0001);
  assert!((stacked_output.1 - 0.5).abs() < 0.0001);
}

#[test]
fn cue_monitor_is_excluded_from_recording_mix() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  install_constant_deck(&mut engine, DeckId::Top, 0.25);
  install_constant_deck(&mut engine, DeckId::Bottom, 0.5);
  engine.set_output_state(-1.0, 1.0);
  engine.set_cue_monitor_enabled(DeckId::Top, true);

  let path = temp_recording_path("cue-monitor");
  let path_string = path.to_string_lossy().into_owned();
  engine.recording.start(path_string).unwrap();
  let output = engine.mix_output_frame();
  let status = engine.recording.stop();
  assert!(status.recorded);

  let recorded = read_first_recorded_frame(&path);
  let _ = fs::remove_file(&path);

  assert!((output.0 - 0.75).abs() < 0.0001);
  assert!((output.1 - 0.75).abs() < 0.0001);
  assert!((recorded.0 - 0.5).abs() < 0.0001);
  assert!((recorded.1 - 0.5).abs() < 0.0001);
}

#[test]
fn cue_monitor_survives_track_change_and_clears_when_deck_is_empty() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.output_sample_rate = 4;
  install_constant_deck(&mut engine, DeckId::Top, 0.25);
  engine.set_cue_monitor_enabled(DeckId::Top, true);

  engine.apply_external_deck_state(
    DeckId::Top,
    1000.0,
    HorizontalBrowseTransportDeckInput {
      file_path: Some("next-track.wav".to_string()),
      title: Some("Next".to_string()),
      bpm: None,
      first_beat_ms: None,
      downbeat_beat_offset: None,
      beat_grid_clips: None,
      time_basis_offset_ms: None,
      duration_sec: 4.0,
      current_sec: 0.0,
      last_observed_at_ms: 1000.0,
      playing: false,
      playback_rate: 1.0,
      master_tempo_enabled: true,
    },
  );
  assert!(engine.deck(DeckId::Top).cue_monitor_enabled);

  engine.apply_external_deck_state(
    DeckId::Top,
    1000.0,
    HorizontalBrowseTransportDeckInput {
      file_path: None,
      title: None,
      bpm: None,
      first_beat_ms: None,
      downbeat_beat_offset: None,
      beat_grid_clips: None,
      time_basis_offset_ms: None,
      duration_sec: 0.0,
      current_sec: 0.0,
      last_observed_at_ms: 1000.0,
      playing: false,
      playback_rate: 1.0,
      master_tempo_enabled: true,
    },
  );
  assert!(!engine.deck(DeckId::Top).cue_monitor_enabled);
  assert!(engine.deck(DeckId::Top).cue_monitor_gain.abs() < 0.0001);
}
