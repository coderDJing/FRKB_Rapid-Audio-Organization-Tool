use super::*;
use parking_lot::Mutex;
use std::sync::OnceLock;

fn finish_decode_request(request: DecodeRequest, decoded: Option<(Vec<f32>, u32, u16)>) {
  match decoded {
    Some((samples, sample_rate, channels)) => {
      let merge_baseline = {
        let engine_guard = engine().lock();
        engine_guard.capture_decode_merge_baseline(
          request.deck,
          &request.file_path,
          request.request_id,
          request.is_full_decode,
        )
      };
      let Some(merge_baseline) = merge_baseline else {
        return;
      };
      let prepared = prepare_decoded_audio(
        Some(merge_baseline),
        samples,
        sample_rate,
        channels,
        request.start_sec,
        request.is_full_decode,
      );
      let mut engine_guard = engine().lock();
      if engine_guard.apply_prepared_decoded_audio(
        request.deck,
        &request.file_path,
        request.request_id,
        prepared,
        request.is_full_decode,
      ) {
        engine_guard.refresh();
      }
    }
    None => {
      let mut engine_guard = engine().lock();
      engine_guard.mark_decode_finished(request.deck, &request.file_path, request.request_id);
      engine_guard.refresh();
    }
  }
}

fn decode_transport_audio_file(file_path: &str) -> Option<(Vec<f32>, u32, u16)> {
  let result = crate::decode_audio_file(file_path.to_string());
  if result.error.is_some() {
    return None;
  }
  let pcm_bytes = result.pcm_data.as_ref();
  if pcm_bytes.len() % 4 != 0 {
    return None;
  }
  let mut samples = Vec::with_capacity(pcm_bytes.len() / 4);
  for chunk in pcm_bytes.chunks_exact(4) {
    samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
  }
  Some((samples, result.sample_rate, result.channels as u16))
}

fn decode_transport_audio_file_head(
  file_path: &str,
  start_sec: f64,
  max_duration_sec: Option<f64>,
) -> Option<(Vec<f32>, u32, u16)> {
  let path = std::path::Path::new(file_path);
  let ffmpeg_pcm = crate::ffmpeg_decode_to_i16_with_window(
    path,
    Some(start_sec.max(0.0)),
    Some(
      max_duration_sec
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(HORIZONTAL_BROWSE_ASYNC_SEGMENT_DECODE_SEC),
    ),
  )
  .ok()?;
  if ffmpeg_pcm.channels == 0 {
    return None;
  }
  let samples = ffmpeg_pcm
    .samples_i16
    .iter()
    .map(|sample| (*sample as f32) / 32768.0)
    .collect::<Vec<f32>>();
  Some((samples, ffmpeg_pcm.sample_rate, ffmpeg_pcm.channels))
}

pub(super) fn schedule_decode_request(request: DecodeRequest) {
  thread::spawn(move || {
    let decoded = if request.is_full_decode {
      decode_transport_audio_file(&request.file_path)
    } else {
      decode_transport_audio_file_head(
        &request.file_path,
        request.start_sec,
        request.max_duration_sec,
      )
    };
    finish_decode_request(request, decoded);
  });
}

pub(super) fn execute_decode_request_sync(request: DecodeRequest) {
  let decoded = if request.is_full_decode {
    decode_transport_audio_file(&request.file_path)
  } else {
    decode_transport_audio_file_head(
      &request.file_path,
      request.start_sec,
      request.max_duration_sec,
    )
  };
  finish_decode_request(request, decoded);
}

static HORIZONTAL_BROWSE_TRANSPORT: OnceLock<Mutex<HorizontalBrowseTransportEngine>> =
  OnceLock::new();
static PREFETCH_THREAD_STARTED: OnceLock<()> = OnceLock::new();

pub(super) fn engine() -> &'static Mutex<HorizontalBrowseTransportEngine> {
  HORIZONTAL_BROWSE_TRANSPORT.get_or_init(|| Mutex::new(HorizontalBrowseTransportEngine::default()))
}

pub(super) fn ensure_prefetch_worker() {
  if PREFETCH_THREAD_STARTED.get().is_some() {
    return;
  }
  let _ = PREFETCH_THREAD_STARTED.set(());
  thread::spawn(|| loop {
    let requests = {
      let mut engine_guard = engine().lock();
      let mut pending = Vec::new();
      for deck in [DeckId::Top, DeckId::Bottom] {
        if let Some(request) = engine_guard.maybe_prepare_followup_segment_decode_request(deck) {
          pending.push(request);
        }
      }
      pending
    };
    for request in requests {
      schedule_decode_request(request);
    }
    thread::sleep(Duration::from_millis(200));
  });
}

pub(super) fn performance_now_ms() -> f64 {
  #[cfg(target_arch = "wasm32")]
  {
    0.0
  }
  #[cfg(not(target_arch = "wasm32"))]
  {
    let now = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default();
    now.as_secs_f64() * 1000.0
  }
}
