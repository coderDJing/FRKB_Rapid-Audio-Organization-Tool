use std::sync::Arc;

use super::*;

fn loaded_engine() -> HorizontalBrowseTransportEngine {
  let mut engine = HorizontalBrowseTransportEngine::default();
  engine.last_now_ms = 1000.0;
  for deck in [DeckId::Top, DeckId::Bottom] {
    let target = engine.deck_mut(deck);
    target.file_path = Some(format!("{deck:?}.wav"));
    target.loaded_file_path = target.file_path.clone();
    target.duration_sec = 20.0;
    target.current_sec = 1.0;
    target.last_observed_at_ms = 1000.0;
    target.sample_rate = 4;
    target.channels = 1;
    target.pcm_data = Arc::new(vec![0.0; 80]);
  }
  engine
}

#[test]
fn a_single_loaded_stopped_deck_automatically_becomes_master() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    let empty = if master == DeckId::Top {
      DeckId::Bottom
    } else {
      DeckId::Top
    };
    engine.deck_mut(empty).file_path = None;

    engine.refresh();

    assert_eq!(engine.leader, Some(master));
    assert!(engine.snapshot(1000.0).leader_deck.is_some());
    assert_eq!(engine.manually_selected_leader, None);
    assert!(!engine.deck(master).playing);
  }
}

#[test]
fn the_first_deck_becomes_master_once_its_audio_is_loaded() {
  let mut engine = loaded_engine();
  engine.bottom.file_path = None;
  let pcm = engine.top.pcm_data.clone();
  engine.top.pcm_data = Arc::new(Vec::new());
  engine.refresh();
  assert_eq!(engine.leader, None);

  engine.top.pcm_data = pcm;
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Top));

  engine.top.file_path = None;
  engine.refresh();
  assert_eq!(engine.leader, None);
}

#[test]
fn loading_a_second_stopped_deck_keeps_the_existing_automatic_master() {
  let mut engine = loaded_engine();
  let top_file_path = engine.top.file_path.take();
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Bottom));

  engine.top.file_path = top_file_path;
  engine.refresh();

  assert_eq!(engine.leader, Some(DeckId::Bottom));
}

#[test]
fn pausing_a_playing_manual_master_hands_over_to_the_playing_deck() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    let follower = if master == DeckId::Top {
      DeckId::Bottom
    } else {
      DeckId::Top
    };
    engine.top.playing = true;
    engine.bottom.playing = true;
    engine.set_leader(Some(master));
    engine.deck_mut(master).playing = false;

    engine.refresh();

    assert_eq!(engine.leader, Some(follower));
    assert_eq!(engine.manually_selected_leader, None);
  }
}

#[test]
fn ejecting_a_stopped_master_hands_over_to_the_other_loaded_deck() {
  for master in [DeckId::Top, DeckId::Bottom] {
    let mut engine = loaded_engine();
    let follower = if master == DeckId::Top {
      DeckId::Bottom
    } else {
      DeckId::Top
    };
    engine.set_leader(Some(master));
    engine.deck_mut(master).file_path = None;

    engine.refresh();

    assert_eq!(engine.leader, Some(follower));
    assert_eq!(engine.manually_selected_leader, None);
    assert!(!engine.deck(follower).playing);
  }
}

#[test]
fn ejecting_the_only_loaded_master_leaves_no_master() {
  let mut engine = loaded_engine();
  engine.bottom.file_path = None;
  engine.set_leader(Some(DeckId::Top));
  engine.top.file_path = None;

  engine.refresh();

  assert_eq!(engine.leader, None);
}

#[test]
fn an_initially_stopped_manual_master_can_play_then_hand_over_when_paused() {
  let mut engine = loaded_engine();
  engine.bottom.playing = true;
  engine.set_leader(Some(DeckId::Top));
  engine.refresh();
  assert_eq!(engine.leader, Some(DeckId::Top));

  engine.top.playing = true;
  engine.refresh();
  engine.top.playing = false;
  engine.refresh();

  assert_eq!(engine.leader, Some(DeckId::Bottom));
}
