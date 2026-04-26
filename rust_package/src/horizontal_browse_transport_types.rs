use napi::bindgen_prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DeckId {
  Top,
  Bottom,
}

impl DeckId {
  pub(super) fn as_str(self) -> &'static str {
    match self {
      DeckId::Top => "top",
      DeckId::Bottom => "bottom",
    }
  }

  pub(super) fn other(self) -> Self {
    match self {
      DeckId::Top => DeckId::Bottom,
      DeckId::Bottom => DeckId::Top,
    }
  }
}

pub(super) fn parse_deck_id(raw: &str) -> napi::Result<DeckId> {
  match raw.trim().to_lowercase().as_str() {
    "top" => Ok(DeckId::Top),
    "bottom" => Ok(DeckId::Bottom),
    _ => Err(Error::from_reason(format!("unknown deck id: {}", raw))),
  }
}

#[napi(object)]
pub struct HorizontalBrowseTransportDeckInput {
  pub file_path: Option<String>,
  pub title: Option<String>,
  pub bpm: Option<f64>,
  pub first_beat_ms: Option<f64>,
  pub time_basis_offset_ms: Option<f64>,
  pub duration_sec: f64,
  pub current_sec: f64,
  pub last_observed_at_ms: f64,
  pub playing: bool,
  pub playback_rate: f64,
  pub master_tempo_enabled: bool,
}

#[napi(object)]
pub struct HorizontalBrowseTransportBeatGridInput {
  pub file_path: Option<String>,
  pub bpm: Option<f64>,
  pub first_beat_ms: Option<f64>,
  pub time_basis_offset_ms: Option<f64>,
}

#[napi(object)]
pub struct HorizontalBrowseTransportStateInput {
  pub now_ms: Option<f64>,
  pub top: HorizontalBrowseTransportDeckInput,
  pub bottom: HorizontalBrowseTransportDeckInput,
}

#[napi(object)]
pub struct HorizontalBrowseTransportDeckSnapshot {
  pub deck: String,
  pub label: String,
  pub loaded: bool,
  pub decoding: bool,
  pub playing: bool,
  pub current_sec: f64,
  pub duration_sec: f64,
  pub playback_rate: f64,
  pub master_tempo_enabled: bool,
  pub bpm: f64,
  pub effective_bpm: f64,
  pub render_current_sec: f64,
  pub sync_enabled: bool,
  pub sync_lock: String,
  pub leader: bool,
  pub loop_active: bool,
  pub loop_beat_value: f64,
  pub loop_start_beat_index: Option<i32>,
  pub loop_start_sec: f64,
  pub loop_end_sec: f64,
}

#[napi(object)]
pub struct HorizontalBrowseTransportOutputSnapshot {
  pub crossfader_value: f64,
  pub master_gain: f64,
  pub top_deck_gain: f64,
  pub bottom_deck_gain: f64,
}

#[napi(object)]
pub struct HorizontalBrowseTransportSnapshot {
  pub leader_deck: Option<String>,
  pub top: HorizontalBrowseTransportDeckSnapshot,
  pub bottom: HorizontalBrowseTransportDeckSnapshot,
  pub output: HorizontalBrowseTransportOutputSnapshot,
}

#[napi(object)]
pub struct HorizontalBrowseTransportVisualizerSnapshot {
  pub time_domain_data: Vec<u8>,
}

pub(super) struct DecodeRequest {
  pub(super) deck: DeckId,
  pub(super) file_path: String,
  pub(super) request_id: u64,
  pub(super) start_sec: f64,
  pub(super) max_duration_sec: Option<f64>,
  pub(super) is_full_decode: bool,
}

#[derive(Clone, Copy)]
pub(super) struct BeatGridSnapshot {
  pub(super) bpm: f64,
  pub(super) beat_sec: f64,
  pub(super) first_beat_sec: f64,
}

#[derive(Clone, Copy)]
pub(super) struct DeckDerivedState {
  pub(super) estimated_current_sec: f64,
  pub(super) effective_bpm: f64,
  pub(super) render_current_sec: f64,
}
