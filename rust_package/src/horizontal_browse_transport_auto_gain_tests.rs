use std::sync::Arc;

use super::*;

fn install_auto_gain_test_deck(
  engine: &mut HorizontalBrowseTransportEngine,
  deck: DeckId,
  file_path: &str,
  integrated_db: f64,
  peak_db: f64,
) {
  let target = engine.deck_mut(deck);
  target.file_path = Some(file_path.to_string());
  target.loaded_file_path = Some(file_path.to_string());
  target.fully_decoded_file_path = Some(file_path.to_string());
  target.duration_sec = 10.0;
  target.sample_rate = 4;
  target.channels = 1;
  target.pcm_start_sec = 0.0;
  target.pcm_data = Arc::new(vec![0.1; 40]);
  target.loudness_analysis = Some(LoudnessAnalysis {
    integrated_db,
    peak_db,
  });
  target.loudness_failed = false;
  target.auto_gain.enabled = true;
  target.auto_gain.current_linear = 1.0;
  target.auto_gain.target_linear = 1.0;
}

fn linear_to_db(value: f32) -> f64 {
  20.0 * (value as f64).max(1e-9).log10()
}

#[test]
fn loudness_analysis_uses_channel_energy_without_phase_cancellation() {
  let samples = [0.5_f32, -0.5, 0.5, -0.5];
  let analysis =
    horizontal_browse_transport_auto_gain::analyze_loudness(&samples, 2).unwrap();

  assert!((analysis.integrated_db - -6.020599913279624).abs() < 0.0001);
  assert!((analysis.peak_db - -6.020599913279624).abs() < 0.0001);
}

#[test]
fn auto_gain_aligns_follower_and_honors_peak_limit() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  install_auto_gain_test_deck(&mut engine, DeckId::Top, "master.wav", -12.0, -3.0);
  install_auto_gain_test_deck(&mut engine, DeckId::Bottom, "follower.wav", -40.0, -5.0);

  engine.set_leader(Some(DeckId::Top));
  engine.refresh_auto_gain();

  let bottom = engine.deck(DeckId::Bottom);
  assert_eq!(bottom.auto_gain.status, "active");
  assert!((linear_to_db(bottom.auto_gain.target_linear) - 4.0).abs() < 0.0001);
}

#[test]
fn auto_gain_master_switch_preserves_existing_master_level() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  install_auto_gain_test_deck(&mut engine, DeckId::Top, "top.wav", -20.0, -8.0);
  install_auto_gain_test_deck(&mut engine, DeckId::Bottom, "bottom.wav", -30.0, -12.0);

  engine.set_leader(Some(DeckId::Top));
  engine.refresh_auto_gain();
  let follower_gain = engine.deck(DeckId::Bottom).auto_gain.target_linear;
  assert!((linear_to_db(follower_gain) - 10.0).abs() < 0.0001);

  engine.set_leader(Some(DeckId::Bottom));
  engine.refresh_auto_gain();

  let new_master = engine.deck(DeckId::Bottom);
  assert_eq!(new_master.auto_gain.status, "master");
  assert!((new_master.auto_gain.target_linear - follower_gain).abs() < 0.00001);
}

#[test]
fn auto_gain_master_switch_preserves_current_effective_level() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  install_auto_gain_test_deck(&mut engine, DeckId::Top, "top.wav", -18.0, -8.0);
  install_auto_gain_test_deck(&mut engine, DeckId::Bottom, "bottom.wav", -30.0, -12.0);
  {
    let bottom = engine.deck_mut(DeckId::Bottom);
    bottom.playing = true;
    bottom.auto_gain.current_linear = 2.0;
    bottom.auto_gain.target_linear = 3.0;
  }

  engine.set_leader(Some(DeckId::Bottom));
  engine.refresh_auto_gain();

  let new_master = engine.deck(DeckId::Bottom);
  assert_eq!(new_master.auto_gain.status, "master");
  assert!((new_master.auto_gain.target_linear - 2.0).abs() < 0.00001);
}

#[test]
fn disabled_master_references_original_loudness() {
  let mut engine = HorizontalBrowseTransportEngine::default();
  install_auto_gain_test_deck(&mut engine, DeckId::Top, "top.wav", -20.0, -8.0);
  install_auto_gain_test_deck(&mut engine, DeckId::Bottom, "bottom.wav", -30.0, -12.0);
  {
    let top = engine.deck_mut(DeckId::Top);
    top.auto_gain.enabled = false;
    top.auto_gain.target_linear = 4.0;
  }

  engine.set_leader(Some(DeckId::Top));
  engine.refresh_auto_gain();

  let follower = engine.deck(DeckId::Bottom);
  assert_eq!(follower.auto_gain.status, "active");
  assert!((linear_to_db(follower.auto_gain.target_linear) - 10.0).abs() < 0.0001);
}
