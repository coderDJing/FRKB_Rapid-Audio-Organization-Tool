use super::*;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex as StdMutex, OnceLock};

const ASYNC_DECODE_WORKER_COUNT: usize = 2;
const STARTUP_DECODE_DIAGNOSTIC_THRESHOLD_MS: f64 = 500.0;
const FULL_DECODE_DIAGNOSTIC_THRESHOLD_MS: f64 = 5000.0;
const MAX_DECODE_DIAGNOSTICS: usize = 64;

#[derive(Clone, Default)]
struct DecodeBackendTrace {
  decoder_backend: Option<String>,
}

enum DecodeRequestAudioResult {
  Decoded {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    ffmpeg_metrics: FfmpegTransportDecodeMetrics,
    backend_trace: DecodeBackendTrace,
  },
  Failed {
    backend_trace: DecodeBackendTrace,
  },
  Cancelled {
    backend_trace: DecodeBackendTrace,
  },
}

struct AsyncDecodeQueue {
  pending: StdMutex<VecDeque<DecodeRequest>>,
  wake: Condvar,
  workers_started: OnceLock<()>,
}

impl AsyncDecodeQueue {
  fn new() -> Self {
    Self {
      pending: StdMutex::new(VecDeque::new()),
      wake: Condvar::new(),
      workers_started: OnceLock::new(),
    }
  }

  fn ensure_workers(&'static self) {
    self.workers_started.get_or_init(|| {
      for _ in 0..ASYNC_DECODE_WORKER_COUNT {
        thread::spawn(move || self.run_worker());
      }
    });
  }

  fn enqueue(&'static self, request: DecodeRequest) {
    self.ensure_workers();
    {
      let mut pending = self
        .pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      pending.retain(|queued| should_keep_queued_decode_request(queued, &request));
      if request.is_full_decode {
        pending.push_back(request);
      } else {
        pending.push_front(request);
      }
    }
    self.wake.notify_one();
  }

  fn run_worker(&'static self) {
    loop {
      let request = {
        let mut pending = self
          .pending
          .lock()
          .unwrap_or_else(|poisoned| poisoned.into_inner());
        while pending.is_empty() {
          pending = self
            .wake
            .wait(pending)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        pending.pop_front()
      };
      let Some(request) = request else {
        continue;
      };
      if !is_decode_request_current(&request) {
        record_decode_request_status(
          &request,
          "async",
          "stale-before-decode",
          request
            .queued_at_ms
            .map(|queued_at| (native_now_ms() - queued_at).max(0.0)),
          0.0,
        );
        continue;
      }
      let started_at_ms = native_now_ms();
      let queue_wait_ms = request
        .queued_at_ms
        .map(|queued_at| (started_at_ms - queued_at).max(0.0));
      let decoded = decode_request_audio(&request);
      finish_decode_request(request, decoded, "async", queue_wait_ms, started_at_ms);
    }
  }
}

fn should_keep_queued_decode_request(queued: &DecodeRequest, request: &DecodeRequest) -> bool {
  queued.deck != request.deck || queued.is_full_decode != request.is_full_decode
}

fn async_decode_queue() -> &'static AsyncDecodeQueue {
  static ASYNC_DECODE_QUEUE: OnceLock<AsyncDecodeQueue> = OnceLock::new();
  ASYNC_DECODE_QUEUE.get_or_init(AsyncDecodeQueue::new)
}

fn is_decode_request_current(request: &DecodeRequest) -> bool {
  let engine_guard = engine().lock();
  engine_guard
    .capture_decode_apply_baseline(
      request.deck,
      &request.file_path,
      request.request_id,
      request.is_full_decode,
    )
    .is_some()
}

fn decode_diagnostics() -> &'static StdMutex<VecDeque<HorizontalBrowseTransportDecodeDiagnostic>> {
  static DECODE_DIAGNOSTICS: OnceLock<
    StdMutex<VecDeque<HorizontalBrowseTransportDecodeDiagnostic>>,
  > = OnceLock::new();
  DECODE_DIAGNOSTICS.get_or_init(|| StdMutex::new(VecDeque::new()))
}

pub(super) fn drain_decode_diagnostics() -> Vec<HorizontalBrowseTransportDecodeDiagnostic> {
  let mut diagnostics = decode_diagnostics()
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  diagnostics.drain(..).collect()
}

fn should_record_decode_diagnostic(diagnostic: &HorizontalBrowseTransportDecodeDiagnostic) -> bool {
  let threshold_ms = if diagnostic.full_decode {
    FULL_DECODE_DIAGNOSTIC_THRESHOLD_MS
  } else {
    STARTUP_DECODE_DIAGNOSTIC_THRESHOLD_MS
  };
  let max_elapsed_ms = diagnostic
    .queue_wait_ms
    .unwrap_or(0.0)
    .max(diagnostic.total_ms)
    .max(diagnostic.ffmpeg_total_ms.unwrap_or(0.0));
  max_elapsed_ms >= threshold_ms
}

fn push_decode_diagnostic(diagnostic: HorizontalBrowseTransportDecodeDiagnostic) {
  if !should_record_decode_diagnostic(&diagnostic) {
    return;
  }
  let mut diagnostics = decode_diagnostics()
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  while diagnostics.len() >= MAX_DECODE_DIAGNOSTICS {
    diagnostics.pop_front();
  }
  diagnostics.push_back(diagnostic);
}

fn empty_decode_diagnostic(
  request: &DecodeRequest,
  operation: &str,
  status: &str,
  queue_wait_ms: Option<f64>,
  total_ms: f64,
) -> HorizontalBrowseTransportDecodeDiagnostic {
  HorizontalBrowseTransportDecodeDiagnostic {
    operation: operation.to_string(),
    status: status.to_string(),
    deck: request.deck.as_str().to_string(),
    file_path: request.file_path.clone(),
    request_id: request.request_id as f64,
    full_decode: request.is_full_decode,
    start_sec: request.start_sec,
    max_duration_sec: request.max_duration_sec,
    decoder_backend: None,
    queue_wait_ms,
    total_ms,
    ffmpeg_total_ms: None,
    ffmpeg_spawn_ms: None,
    ffmpeg_first_byte_ms: None,
    ffmpeg_read_ms: None,
    ffmpeg_convert_ms: None,
    ffmpeg_wait_ms: None,
    ffmpeg_stderr_join_ms: None,
    ffmpeg_stdout_bytes: None,
    ffmpeg_read_iterations: None,
    prepare_ms: None,
    apply_ms: None,
    loudness_ms: None,
    sample_count: 0.0,
    frame_count: 0.0,
    sample_rate: 0.0,
    channels: 0.0,
  }
}

fn record_decode_request_status(
  request: &DecodeRequest,
  operation: &str,
  status: &str,
  queue_wait_ms: Option<f64>,
  total_ms: f64,
) {
  record_decode_request_status_with_trace(
    request,
    operation,
    status,
    queue_wait_ms,
    total_ms,
    DecodeBackendTrace::default(),
  );
}

fn record_decode_request_status_with_trace(
  request: &DecodeRequest,
  operation: &str,
  status: &str,
  queue_wait_ms: Option<f64>,
  total_ms: f64,
  backend_trace: DecodeBackendTrace,
) {
  let mut diagnostic = empty_decode_diagnostic(request, operation, status, queue_wait_ms, total_ms);
  diagnostic.decoder_backend = backend_trace.decoder_backend;
  push_decode_diagnostic(diagnostic);
}

fn finish_decode_request(
  request: DecodeRequest,
  decoded: DecodeRequestAudioResult,
  operation: &str,
  queue_wait_ms: Option<f64>,
  started_at_ms: f64,
) {
  match decoded {
    DecodeRequestAudioResult::Decoded {
      samples,
      sample_rate,
      channels,
      ffmpeg_metrics,
      backend_trace,
    } => {
      let sample_count = samples.len() as f64;
      let frame_count = if channels > 0 {
        samples.len() as f64 / channels as f64
      } else {
        0.0
      };
      let loudness_started_at_ms = native_now_ms();
      let loudness_analysis = if request.is_full_decode {
        super::horizontal_browse_transport_auto_gain::analyze_loudness(&samples, channels)
      } else {
        None
      };
      let loudness_ms = if request.is_full_decode {
        Some((native_now_ms() - loudness_started_at_ms).max(0.0))
      } else {
        None
      };
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
        record_decode_request_status_with_trace(
          &request,
          operation,
          "stale-before-prepare",
          queue_wait_ms,
          (native_now_ms() - started_at_ms).max(0.0),
          backend_trace,
        );
        return;
      };
      let prepare_started_at_ms = native_now_ms();
      let prepared = prepare_decoded_audio(
        Some(apply_baseline),
        samples,
        sample_rate,
        channels,
        request.start_sec,
        request.is_full_decode,
      );
      let prepare_ms = (native_now_ms() - prepare_started_at_ms).max(0.0);
      let apply_started_at_ms = native_now_ms();
      let (applied, full_decode_request) = {
        let mut engine_guard = engine().lock();
        if engine_guard.apply_prepared_decoded_audio(
          request.deck,
          &request.file_path,
          request.request_id,
          prepared,
          request.is_full_decode,
        ) {
          if request.is_full_decode {
            engine_guard.set_deck_loudness_result(
              request.deck,
              &request.file_path,
              loudness_analysis,
            );
          }
          engine_guard.refresh();
          engine_guard.refresh_auto_gain();
          if request.is_full_decode {
            (true, None)
          } else {
            (true, engine_guard.prepare_full_decode_request(request.deck))
          }
        } else {
          (false, None)
        }
      };
      let apply_ms = (native_now_ms() - apply_started_at_ms).max(0.0);
      push_decode_diagnostic(HorizontalBrowseTransportDecodeDiagnostic {
        operation: operation.to_string(),
        status: if applied { "decoded" } else { "apply-stale" }.to_string(),
        deck: request.deck.as_str().to_string(),
        file_path: request.file_path.clone(),
        request_id: request.request_id as f64,
        full_decode: request.is_full_decode,
        start_sec: request.start_sec,
        max_duration_sec: request.max_duration_sec,
        decoder_backend: backend_trace.decoder_backend,
        queue_wait_ms,
        total_ms: (native_now_ms() - started_at_ms).max(0.0),
        ffmpeg_total_ms: Some(ffmpeg_metrics.total_ms),
        ffmpeg_spawn_ms: Some(ffmpeg_metrics.spawn_ms),
        ffmpeg_first_byte_ms: ffmpeg_metrics.first_byte_ms,
        ffmpeg_read_ms: Some(ffmpeg_metrics.read_ms),
        ffmpeg_convert_ms: Some(ffmpeg_metrics.convert_ms),
        ffmpeg_wait_ms: Some(ffmpeg_metrics.wait_ms),
        ffmpeg_stderr_join_ms: Some(ffmpeg_metrics.stderr_join_ms),
        ffmpeg_stdout_bytes: Some(ffmpeg_metrics.stdout_bytes),
        ffmpeg_read_iterations: Some(ffmpeg_metrics.read_iterations),
        prepare_ms: Some(prepare_ms),
        apply_ms: Some(apply_ms),
        loudness_ms,
        sample_count,
        frame_count,
        sample_rate: sample_rate as f64,
        channels: channels as f64,
      });
      if let Some(request) = full_decode_request {
        schedule_decode_request(request);
      }
    }
    DecodeRequestAudioResult::Failed { backend_trace } => {
      let mut engine_guard = engine().lock();
      engine_guard.mark_decode_finished(
        request.deck,
        &request.file_path,
        request.request_id,
        request.is_full_decode,
      );
      engine_guard.refresh();
      if request.is_full_decode {
        engine_guard.set_deck_loudness_result(request.deck, &request.file_path, None);
      } else {
        engine_guard.refresh_auto_gain();
      }
      record_decode_request_status_with_trace(
        &request,
        operation,
        "failed",
        queue_wait_ms,
        (native_now_ms() - started_at_ms).max(0.0),
        backend_trace,
      );
    }
    DecodeRequestAudioResult::Cancelled { backend_trace } => {
      record_decode_request_status_with_trace(
        &request,
        operation,
        "cancelled",
        queue_wait_ms,
        (native_now_ms() - started_at_ms).max(0.0),
        backend_trace,
      );
    }
  }
}

fn decode_transport_audio_file(
  request: &DecodeRequest,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
) -> DecodeRequestAudioResult {
  let path = std::path::Path::new(&request.file_path);
  let (decoded, backend_trace) = if request.is_full_decode {
    (
      crate::ffmpeg_decode_transport_native_cancellable(path, start_sec, max_duration_sec, || {
        !is_decode_request_current(request)
      }),
      DecodeBackendTrace {
        decoder_backend: Some("native-libav".to_string()),
      },
    )
  } else {
    (
      crate::ffmpeg_decode_transport_native(path, start_sec, max_duration_sec).map(Some),
      DecodeBackendTrace {
        decoder_backend: Some("native-libav".to_string()),
      },
    )
  };
  match decoded {
    Ok(Some(ffmpeg_pcm)) => {
      if ffmpeg_pcm.channels > 0 {
        DecodeRequestAudioResult::Decoded {
          samples: ffmpeg_pcm.samples_f32,
          sample_rate: ffmpeg_pcm.sample_rate,
          channels: ffmpeg_pcm.channels,
          ffmpeg_metrics: ffmpeg_pcm.metrics,
          backend_trace,
        }
      } else {
        DecodeRequestAudioResult::Failed { backend_trace }
      }
    }
    Ok(None) => DecodeRequestAudioResult::Cancelled { backend_trace },
    Err(_) => DecodeRequestAudioResult::Failed { backend_trace },
  }
}

pub(super) fn schedule_decode_request(mut request: DecodeRequest) {
  request.queued_at_ms = Some(native_now_ms());
  async_decode_queue().enqueue(request);
}

fn decode_request_audio(request: &DecodeRequest) -> DecodeRequestAudioResult {
  if request.is_full_decode {
    decode_transport_audio_file(request, None, None)
  } else {
    decode_transport_audio_file(
      request,
      Some(request.start_sec.max(0.0)),
      Some(
        request
          .max_duration_sec
          .filter(|value| value.is_finite() && *value > 0.0)
          .unwrap_or(HORIZONTAL_BROWSE_STARTUP_DECODE_SEC),
      ),
    )
  }
}

pub(super) fn execute_decode_request_sync(request: DecodeRequest) {
  let started_at_ms = native_now_ms();
  if !is_decode_request_current(&request) {
    record_decode_request_status(&request, "sync", "stale-before-decode", None, 0.0);
    return;
  }
  let decoded = decode_request_audio(&request);
  finish_decode_request(request, decoded, "sync", None, started_at_ms);
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

#[cfg(test)]
mod tests {
  use super::*;

  fn decode_request(deck: DeckId, is_full_decode: bool) -> DecodeRequest {
    DecodeRequest {
      deck,
      file_path: "track.mp3".to_string(),
      request_id: 1,
      start_sec: 0.0,
      max_duration_sec: if is_full_decode { None } else { Some(10.0) },
      is_full_decode,
      queued_at_ms: None,
    }
  }

  #[test]
  fn queued_startup_and_full_decode_do_not_replace_each_other() {
    let queued_startup = decode_request(DeckId::Top, false);
    let next_full = decode_request(DeckId::Top, true);
    assert!(should_keep_queued_decode_request(
      &queued_startup,
      &next_full
    ));

    let queued_full = decode_request(DeckId::Top, true);
    let next_startup = decode_request(DeckId::Top, false);
    assert!(should_keep_queued_decode_request(
      &queued_full,
      &next_startup
    ));
  }

  #[test]
  fn queued_decode_replaces_same_deck_same_decode_kind_only() {
    let queued_startup = decode_request(DeckId::Top, false);
    let next_startup = decode_request(DeckId::Top, false);
    assert!(!should_keep_queued_decode_request(
      &queued_startup,
      &next_startup
    ));

    let other_deck_startup = decode_request(DeckId::Bottom, false);
    assert!(should_keep_queued_decode_request(
      &other_deck_startup,
      &next_startup
    ));
  }
}
