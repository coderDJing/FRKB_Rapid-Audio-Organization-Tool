use super::*;

impl HorizontalBrowseTransportEngine {
  pub(super) fn prepare_decode_request(&mut self, deck: DeckId) -> Option<DecodeRequest> {
    self.prepare_decode_request_inner(deck, false)
  }

  pub(super) fn prepare_playhead_decode_request(&mut self, deck: DeckId) -> Option<DecodeRequest> {
    self.prepare_decode_request_inner(deck, true)
  }

  fn prepare_decode_request_inner(
    &mut self,
    deck: DeckId,
    replace_pending: bool,
  ) -> Option<DecodeRequest> {
    let file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim().to_string())
      .unwrap_or_default();
    if file_path.is_empty() {
      let target = self.deck_mut(deck);
      target.loaded_file_path = None;
      target.fully_decoded_file_path = None;
      target.pending_decode_file_path = None;
      target.pending_decode_start_sec = None;
      target.pending_decode_max_duration_sec = None;
      target.pending_full_decode_file_path = None;
      target.pcm_data = Arc::new(Vec::new());
      target.pcm_start_sec = 0.0;
      target.sample_rate = 0;
      target.channels = 0;
      horizontal_browse_transport_audio::clear_master_tempo_state(target);
      horizontal_browse_transport_audio::reset_band_filter_state(target);
      self.mark_state_changed();
      return None;
    }

    let startup_target_sec = self.resolve_startup_decode_target_sec(deck);
    let startup_start_sec = self.resolve_startup_decode_start_sec(deck, startup_target_sec);
    if self.has_loaded_segment_covering(deck, startup_target_sec) {
      return None;
    }

    let pending_start_sec = self.deck(deck).pending_decode_start_sec;
    let pending_max_duration_sec = self.deck(deck).pending_decode_max_duration_sec;
    let pending_matches_file =
      self.deck(deck).pending_decode_file_path.as_deref() == Some(file_path.as_str());
    if pending_matches_file {
      if !replace_pending {
        return None;
      }
      let target_audio_sec = Self::timeline_sec_to_audio_sec(self.deck(deck), startup_target_sec);
      if Self::decode_request_window_covers(
        pending_start_sec,
        pending_max_duration_sec,
        target_audio_sec,
      ) {
        return None;
      }
    }

    let should_reset_loaded_audio =
      self.deck(deck).loaded_file_path.as_deref().map(str::trim) != Some(file_path.as_str());
    let target = self.deck_mut(deck);
    target.decode_request_id = target.decode_request_id.wrapping_add(1);
    let request_id = target.decode_request_id;
    target.pending_decode_file_path = Some(file_path.clone());
    target.pending_decode_start_sec = Some(startup_start_sec);
    target.pending_decode_max_duration_sec = Some(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC);
    if should_reset_loaded_audio {
      target.loaded_file_path = None;
      target.fully_decoded_file_path = None;
      target.pending_full_decode_file_path = None;
      target.pcm_data = Arc::new(Vec::new());
      target.pcm_start_sec = 0.0;
      target.sample_rate = 0;
      target.channels = 0;
      horizontal_browse_transport_audio::clear_master_tempo_state(target);
      horizontal_browse_transport_audio::reset_band_filter_state(target);
    }
    self.mark_state_changed();
    Some(DecodeRequest {
      deck,
      file_path,
      request_id,
      start_sec: startup_start_sec,
      max_duration_sec: Some(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC),
      is_full_decode: false,
      queued_at_ms: None,
    })
  }

  fn decode_request_window_covers(
    start_sec: Option<f64>,
    max_duration_sec: Option<f64>,
    target_audio_sec: f64,
  ) -> bool {
    let Some(start_sec) = start_sec else {
      return false;
    };
    let Some(max_duration_sec) = max_duration_sec else {
      return false;
    };
    if !start_sec.is_finite() || !max_duration_sec.is_finite() || !target_audio_sec.is_finite() {
      return false;
    }
    target_audio_sec + 0.0001 >= start_sec
      && target_audio_sec < start_sec + max_duration_sec - 0.0001
  }

  pub(super) fn prepare_full_decode_request(&mut self, deck: DeckId) -> Option<DecodeRequest> {
    let file_path = self
      .deck(deck)
      .file_path
      .as_ref()
      .map(|value| value.trim().to_string())
      .unwrap_or_default();
    if file_path.is_empty() || self.is_fully_decoded(deck) {
      return None;
    }
    if !self.is_loaded(deck) {
      return None;
    }
    if self.deck(deck).pending_full_decode_file_path.as_deref() == Some(file_path.as_str()) {
      return None;
    }
    let target = self.deck_mut(deck);
    target.full_decode_request_id = target.full_decode_request_id.wrapping_add(1);
    let request_id = target.full_decode_request_id;
    target.pending_full_decode_file_path = Some(file_path.clone());
    self.mark_state_changed();
    Some(DecodeRequest {
      deck,
      file_path,
      request_id,
      start_sec: 0.0,
      max_duration_sec: None,
      is_full_decode: true,
      queued_at_ms: None,
    })
  }

  fn request_matches(
    &self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) -> bool {
    let current_state = self.deck(deck);
    let current_file_path = current_state
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    let request_matches = if fully_decoded {
      current_state.full_decode_request_id == request_id
    } else {
      current_state.decode_request_id == request_id
    };
    current_file_path == file_path && request_matches
  }

  pub(super) fn capture_decode_apply_baseline(
    &self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) -> Option<DecodeApplyBaseline> {
    if !self.request_matches(deck, file_path, request_id, fully_decoded) {
      return None;
    }
    let deck_state = self.deck(deck);
    Some(DecodeApplyBaseline {
      pcm_start_sec: deck_state.pcm_start_sec,
      sample_rate: deck_state.sample_rate,
      channels: deck_state.channels,
    })
  }

  pub(super) fn apply_prepared_decoded_audio(
    &mut self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    prepared: PreparedDecodedAudio,
    fully_decoded: bool,
  ) -> bool {
    if !self.request_matches(deck, file_path, request_id, fully_decoded) {
      return false;
    }
    let output_sample_rate = self.output_sample_rate.max(1) as f64;
    let target = self.deck_mut(deck);
    let should_reset_master_tempo = !prepared.preserve_master_tempo_state
      || target.sample_rate != prepared.sample_rate
      || target.channels != prepared.channels
      || (target.pcm_start_sec - prepared.pcm_start_sec).abs() > 0.0001;
    target.loaded_file_path = Some(file_path.to_string());
    target.pcm_data = prepared.pcm_data;
    target.pcm_start_sec = prepared.pcm_start_sec;
    target.sample_rate = prepared.sample_rate;
    target.channels = prepared.channels;
    if fully_decoded {
      target.pending_full_decode_file_path = None;
      target.pending_decode_file_path = None;
      target.pending_decode_start_sec = None;
      target.pending_decode_max_duration_sec = None;
      target.fully_decoded_file_path = Some(file_path.to_string());
      target.decode_request_id = target.decode_request_id.wrapping_add(1);
    } else {
      target.pending_decode_file_path = None;
      target.pending_decode_start_sec = None;
      target.pending_decode_max_duration_sec = None;
      target.fully_decoded_file_path = None;
    }
    if should_reset_master_tempo {
      horizontal_browse_transport_audio::reset_master_tempo_state(target);
      horizontal_browse_transport_audio::prime_master_tempo_state(target, output_sample_rate);
      horizontal_browse_transport_audio::reset_band_filter_state(target);
    }
    self.mark_state_changed();
    true
  }

  pub(super) fn mark_decode_finished(
    &mut self,
    deck: DeckId,
    file_path: &str,
    request_id: u64,
    fully_decoded: bool,
  ) {
    let current_state = self.deck(deck);
    let current_file_path = current_state
      .file_path
      .as_ref()
      .map(|value| value.trim())
      .unwrap_or("");
    let full_decode_request_id = current_state.full_decode_request_id;
    let decode_request_id = current_state.decode_request_id;
    if current_file_path != file_path {
      return;
    }
    let target = self.deck_mut(deck);
    if fully_decoded && full_decode_request_id == request_id {
      target.pending_full_decode_file_path = None;
    } else if !fully_decoded && decode_request_id == request_id {
      target.pending_decode_file_path = None;
      target.pending_decode_start_sec = None;
      target.pending_decode_max_duration_sec = None;
    }
    self.mark_state_changed();
  }
}

pub(super) fn prepare_decoded_audio(
  baseline: Option<DecodeApplyBaseline>,
  samples: Vec<f32>,
  sample_rate: u32,
  channels: u16,
  start_sec: f64,
  fully_decoded: bool,
) -> PreparedDecodedAudio {
  let pcm_start_sec = if fully_decoded {
    0.0
  } else {
    start_sec.max(0.0)
  };
  let preserve_master_tempo_state = baseline
    .as_ref()
    .map(|existing| {
      existing.sample_rate == sample_rate
        && existing.channels == channels
        && (existing.pcm_start_sec - pcm_start_sec).abs() <= 0.0001
    })
    .unwrap_or(false);
  PreparedDecodedAudio {
    pcm_data: Arc::new(samples),
    pcm_start_sec,
    sample_rate,
    channels,
    preserve_master_tempo_state,
  }
}
