use super::*;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

fn finish_decode_request(request: DecodeRequest, decoded: Option<(Vec<f32>, u32, u16)>) {
  match decoded {
    Some((samples, sample_rate, channels)) => {
      let apply_baseline = {
        let engine_guard = engine().lock();
        engine_guard.capture_decode_apply_baseline(
          request.deck,
          &request.file_path,
          request.request_id,
          request.is_full_decode,
        )
      };
      let Some(apply_baseline) = apply_baseline else {
        return;
      };
      let prepared = prepare_decoded_audio(
        Some(apply_baseline),
        samples,
        sample_rate,
        channels,
        request.start_sec,
        request.is_full_decode,
      );
      let full_decode_request = {
        let mut engine_guard = engine().lock();
        if engine_guard.apply_prepared_decoded_audio(
          request.deck,
          &request.file_path,
          request.request_id,
          prepared,
          request.is_full_decode,
        ) {
          engine_guard.refresh();
          if request.is_full_decode {
            None
          } else {
            engine_guard.prepare_full_decode_request(request.deck)
          }
        } else {
          None
        }
      };
      if let Some(request) = full_decode_request {
        schedule_decode_request(request);
      }
    }
    None => {
      let mut engine_guard = engine().lock();
      engine_guard.mark_decode_finished(
        request.deck,
        &request.file_path,
        request.request_id,
        request.is_full_decode,
      );
      engine_guard.refresh();
    }
  }
}

fn decode_transport_audio_file(file_path: &str) -> Option<(Vec<f32>, u32, u16)> {
  let path = std::path::Path::new(file_path);
  let ffmpeg_pcm = crate::ffmpeg_decode_transport_raw_pipe(path, None, None).ok()?;
  if ffmpeg_pcm.channels == 0 {
    return None;
  }
  Some((
    ffmpeg_pcm.samples_f32,
    ffmpeg_pcm.sample_rate,
    ffmpeg_pcm.channels,
  ))
}

fn decode_transport_audio_file_head(
  file_path: &str,
  start_sec: f64,
  max_duration_sec: Option<f64>,
) -> Option<(Vec<f32>, u32, u16)> {
  let path = std::path::Path::new(file_path);
  let ffmpeg_pcm = crate::ffmpeg_decode_transport_raw_pipe(
    path,
    Some(start_sec.max(0.0)),
    Some(
      max_duration_sec
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC),
    ),
  )
  .ok()?;
  if ffmpeg_pcm.channels == 0 {
    return None;
  }
  Some((
    ffmpeg_pcm.samples_f32,
    ffmpeg_pcm.sample_rate,
    ffmpeg_pcm.channels,
  ))
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
static NATIVE_CLOCK_STARTED_AT: OnceLock<std::time::Instant> = OnceLock::new();
static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn engine() -> &'static Mutex<HorizontalBrowseTransportEngine> {
  HORIZONTAL_BROWSE_TRANSPORT.get_or_init(|| Mutex::new(HorizontalBrowseTransportEngine::default()))
}

pub(super) fn native_now_ms() -> f64 {
  NATIVE_CLOCK_STARTED_AT
    .get_or_init(std::time::Instant::now)
    .elapsed()
    .as_secs_f64()
    * 1000.0
}

pub(super) fn next_snapshot_sequence() -> f64 {
  SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed) as f64 + 1.0
}
