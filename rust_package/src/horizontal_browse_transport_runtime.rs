use super::*;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex as StdMutex, OnceLock};

const ASYNC_DECODE_WORKER_COUNT: usize = 2;

enum DecodeRequestAudioResult {
  Decoded(Vec<f32>, u32, u16),
  Failed,
  Cancelled,
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
      pending.retain(|queued| queued.deck != request.deck);
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
        continue;
      }
      let decoded = decode_request_audio(&request);
      finish_decode_request(request, decoded);
    }
  }
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

fn finish_decode_request(request: DecodeRequest, decoded: DecodeRequestAudioResult) {
  match decoded {
    DecodeRequestAudioResult::Decoded(samples, sample_rate, channels) => {
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
    DecodeRequestAudioResult::Failed => {
      let mut engine_guard = engine().lock();
      engine_guard.mark_decode_finished(
        request.deck,
        &request.file_path,
        request.request_id,
        request.is_full_decode,
      );
      engine_guard.refresh();
    }
    DecodeRequestAudioResult::Cancelled => {}
  }
}

fn decode_transport_audio_file(
  request: &DecodeRequest,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
) -> DecodeRequestAudioResult {
  let path = std::path::Path::new(&request.file_path);
  let decoded =
    crate::ffmpeg_decode_transport_raw_pipe_cancellable(path, start_sec, max_duration_sec, || {
      !is_decode_request_current(request)
    });
  match decoded {
    Ok(Some(ffmpeg_pcm)) if ffmpeg_pcm.channels > 0 => DecodeRequestAudioResult::Decoded(
      ffmpeg_pcm.samples_f32,
      ffmpeg_pcm.sample_rate,
      ffmpeg_pcm.channels,
    ),
    Ok(Some(_)) => DecodeRequestAudioResult::Failed,
    Ok(None) => DecodeRequestAudioResult::Cancelled,
    Err(_) => DecodeRequestAudioResult::Failed,
  }
}

pub(super) fn schedule_decode_request(request: DecodeRequest) {
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
  if !is_decode_request_current(&request) {
    return;
  }
  let decoded = decode_request_audio(&request);
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
