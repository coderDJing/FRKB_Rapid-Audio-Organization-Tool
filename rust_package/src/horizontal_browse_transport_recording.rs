use std::fs::{self, File};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;
use std::thread;

use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use napi::bindgen_prelude::*;

const RECORDING_SIGNAL_THRESHOLD: f32 = 0.0005;
const RECORDING_CHANNELS: u16 = 2;
const RECORDING_QUEUE_CAPACITY: usize = 256;
const RECORDING_FLUSH_FRAMES: usize = 2048;
const WAV_FLOAT_FORMAT_CODE: u16 = 3;
const WAV_BITS_PER_SAMPLE: u16 = 32;
const WAV_BYTES_PER_SAMPLE: u16 = WAV_BITS_PER_SAMPLE / 8;

#[napi(object)]
pub struct HorizontalBrowseTransportRecordingStatus {
  pub state: String,
  pub file_path: Option<String>,
  pub sample_rate: u32,
  pub channels: u32,
  pub recorded_frames: f64,
  pub recorded: bool,
  pub error: Option<String>,
}

enum RecordingWriterMessage {
  Samples(Vec<f32>),
  Finish,
}

struct RecordingWriterResult {
  frames_written: u64,
  error: Option<String>,
}

struct RecordingSession {
  file_path: String,
  sample_rate: u32,
  channels: u16,
  sender: Option<Sender<RecordingWriterMessage>>,
  join_handle: Option<thread::JoinHandle<RecordingWriterResult>>,
  pending_samples: Vec<f32>,
  recorded_frames: u64,
  error: Option<String>,
}

enum RecordingState {
  Idle,
  Armed { file_path: String },
  Recording(RecordingSession),
}

pub(super) struct RecordingController {
  state: RecordingState,
}

impl Default for RecordingController {
  fn default() -> Self {
    Self {
      state: RecordingState::Idle,
    }
  }
}

impl Drop for RecordingSession {
  fn drop(&mut self) {
    let _ = self.flush_pending();
    if let Some(sender) = self.sender.take() {
      let _ = sender.send(RecordingWriterMessage::Finish);
    }
    if let Some(join_handle) = self.join_handle.take() {
      let _ = join_handle.join();
    }
  }
}

impl RecordingSession {
  fn new(file_path: String, sample_rate: u32) -> Self {
    let (sender, receiver) = bounded::<RecordingWriterMessage>(RECORDING_QUEUE_CAPACITY);
    let writer_path = file_path.clone();
    let join_handle =
      thread::spawn(move || run_recording_writer(writer_path, sample_rate, receiver));
    Self {
      file_path,
      sample_rate,
      channels: RECORDING_CHANNELS,
      sender: Some(sender),
      join_handle: Some(join_handle),
      pending_samples: Vec::with_capacity(RECORDING_FLUSH_FRAMES * RECORDING_CHANNELS as usize),
      recorded_frames: 0,
      error: None,
    }
  }

  fn push_frame(&mut self, left: f32, right: f32) {
    if self.error.is_some() {
      return;
    }
    self.pending_samples.push(left.clamp(-1.0, 1.0));
    self.pending_samples.push(right.clamp(-1.0, 1.0));
    self.recorded_frames = self.recorded_frames.saturating_add(1);
    if self.pending_samples.len() >= RECORDING_FLUSH_FRAMES * self.channels as usize {
      let _ = self.flush_pending();
    }
  }

  fn flush_pending(&mut self) -> bool {
    if self.pending_samples.is_empty() || self.error.is_some() {
      return true;
    }
    let Some(sender) = self.sender.as_ref() else {
      self.error = Some("recording writer is closed".to_string());
      self.pending_samples.clear();
      return false;
    };
    let samples = std::mem::take(&mut self.pending_samples);
    match sender.try_send(RecordingWriterMessage::Samples(samples)) {
      Ok(_) => true,
      Err(TrySendError::Full(samples_msg)) => {
        if let RecordingWriterMessage::Samples(samples) = samples_msg {
          self.pending_samples = samples;
        }
        self.error = Some("recording writer queue is full".to_string());
        false
      }
      Err(TrySendError::Disconnected(_)) => {
        self.error = Some("recording writer stopped".to_string());
        false
      }
    }
  }

  fn finish(mut self) -> RecordingWriterResult {
    let existing_error = self.error.clone();
    let pending_error = existing_error.or_else(|| {
      if self.flush_pending() {
        None
      } else {
        self.error.clone()
      }
    });
    if let Some(sender) = self.sender.take() {
      let _ = sender.send(RecordingWriterMessage::Finish);
    }
    let writer_result = if let Some(join_handle) = self.join_handle.take() {
      join_handle
        .join()
        .unwrap_or_else(|_| RecordingWriterResult {
          frames_written: 0,
          error: Some("recording writer thread panicked".to_string()),
        })
    } else {
      RecordingWriterResult {
        frames_written: 0,
        error: Some("recording writer thread missing".to_string()),
      }
    };
    RecordingWriterResult {
      frames_written: writer_result.frames_written,
      error: pending_error.or(writer_result.error),
    }
  }
}

impl RecordingController {
  pub(super) fn start(
    &mut self,
    file_path: String,
  ) -> napi::Result<HorizontalBrowseTransportRecordingStatus> {
    if !matches!(self.state, RecordingState::Idle) {
      return Ok(self.snapshot());
    }
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
      return Err(Error::from_reason("recording output path is empty"));
    }
    self.state = RecordingState::Armed {
      file_path: trimmed.to_string(),
    };
    Ok(self.snapshot())
  }

  pub(super) fn stop(&mut self) -> HorizontalBrowseTransportRecordingStatus {
    let state = std::mem::replace(&mut self.state, RecordingState::Idle);
    match state {
      RecordingState::Idle => HorizontalBrowseTransportRecordingStatus {
        state: "idle".to_string(),
        file_path: None,
        sample_rate: 0,
        channels: RECORDING_CHANNELS as u32,
        recorded_frames: 0.0,
        recorded: false,
        error: None,
      },
      RecordingState::Armed { file_path } => HorizontalBrowseTransportRecordingStatus {
        state: "idle".to_string(),
        file_path: Some(file_path),
        sample_rate: 0,
        channels: RECORDING_CHANNELS as u32,
        recorded_frames: 0.0,
        recorded: false,
        error: None,
      },
      RecordingState::Recording(session) => {
        let file_path = session.file_path.clone();
        let sample_rate = session.sample_rate;
        let channels = session.channels;
        let result = session.finish();
        if result.frames_written == 0 || result.error.is_some() {
          let _ = fs::remove_file(&file_path);
        }
        HorizontalBrowseTransportRecordingStatus {
          state: "idle".to_string(),
          file_path: Some(file_path),
          sample_rate,
          channels: channels as u32,
          recorded_frames: result.frames_written as f64,
          recorded: result.frames_written > 0 && result.error.is_none(),
          error: result.error,
        }
      }
    }
  }

  pub(super) fn capture_frame(&mut self, sample_rate: u32, left: f32, right: f32) {
    let level = left.abs().max(right.abs());
    match &mut self.state {
      RecordingState::Idle => {}
      RecordingState::Armed { file_path } => {
        if level <= RECORDING_SIGNAL_THRESHOLD {
          return;
        }
        let path = file_path.clone();
        let resolved_sample_rate = sample_rate.max(1);
        let mut session = RecordingSession::new(path, resolved_sample_rate);
        session.push_frame(left, right);
        self.state = RecordingState::Recording(session);
      }
      RecordingState::Recording(session) => {
        session.push_frame(left, right);
      }
    }
  }

  pub(super) fn snapshot(&self) -> HorizontalBrowseTransportRecordingStatus {
    match &self.state {
      RecordingState::Idle => HorizontalBrowseTransportRecordingStatus {
        state: "idle".to_string(),
        file_path: None,
        sample_rate: 0,
        channels: RECORDING_CHANNELS as u32,
        recorded_frames: 0.0,
        recorded: false,
        error: None,
      },
      RecordingState::Armed { file_path } => HorizontalBrowseTransportRecordingStatus {
        state: "armed".to_string(),
        file_path: Some(file_path.clone()),
        sample_rate: 0,
        channels: RECORDING_CHANNELS as u32,
        recorded_frames: 0.0,
        recorded: false,
        error: None,
      },
      RecordingState::Recording(session) => {
        let error = session.error.clone();
        HorizontalBrowseTransportRecordingStatus {
          state: if error.is_some() {
            "error"
          } else {
            "recording"
          }
          .to_string(),
          file_path: Some(session.file_path.clone()),
          sample_rate: session.sample_rate,
          channels: session.channels as u32,
          recorded_frames: session.recorded_frames as f64,
          recorded: false,
          error,
        }
      }
    }
  }
}

fn run_recording_writer(
  file_path: String,
  sample_rate: u32,
  receiver: Receiver<RecordingWriterMessage>,
) -> RecordingWriterResult {
  let path = Path::new(&file_path);
  let mut file = match File::create(path) {
    Ok(file) => file,
    Err(error) => {
      return RecordingWriterResult {
        frames_written: 0,
        error: Some(format!("create recording file failed: {}", error)),
      }
    }
  };
  if let Err(error) = write_wav_header(&mut file, sample_rate, RECORDING_CHANNELS, 0) {
    return RecordingWriterResult {
      frames_written: 0,
      error: Some(format!("write wav header failed: {}", error)),
    };
  }

  let mut frames_written = 0_u64;
  let mut error: Option<String> = None;
  while let Ok(message) = receiver.recv() {
    match message {
      RecordingWriterMessage::Samples(samples) => match write_float_samples(&mut file, &samples) {
        Ok(()) => {
          frames_written =
            frames_written.saturating_add((samples.len() / RECORDING_CHANNELS as usize) as u64);
        }
        Err(write_error) => {
          error = Some(format!("write recording samples failed: {}", write_error));
          break;
        }
      },
      RecordingWriterMessage::Finish => break,
    }
  }

  if error.is_none() {
    if let Err(finalize_error) = write_wav_header(
      &mut file,
      sample_rate,
      RECORDING_CHANNELS,
      recording_data_bytes(frames_written),
    ) {
      error = Some(format!("finalize wav header failed: {}", finalize_error));
    }
  }
  if error.is_none() {
    if let Err(flush_error) = file.flush() {
      error = Some(format!("flush recording file failed: {}", flush_error));
    }
  }
  RecordingWriterResult {
    frames_written,
    error,
  }
}

fn recording_data_bytes(frames: u64) -> u64 {
  frames
    .saturating_mul(RECORDING_CHANNELS as u64)
    .saturating_mul(WAV_BYTES_PER_SAMPLE as u64)
}

fn write_float_samples(file: &mut File, samples: &[f32]) -> io::Result<()> {
  let mut bytes = Vec::with_capacity(samples.len() * WAV_BYTES_PER_SAMPLE as usize);
  for sample in samples {
    bytes.extend_from_slice(&sample.clamp(-1.0, 1.0).to_le_bytes());
  }
  file.write_all(&bytes)
}

fn write_wav_header(
  file: &mut File,
  sample_rate: u32,
  channels: u16,
  data_bytes: u64,
) -> io::Result<()> {
  let data_size = u32::try_from(data_bytes).map_err(|_| {
    io::Error::new(
      io::ErrorKind::InvalidData,
      "recording is too large for a classic WAV file",
    )
  })?;
  let riff_size = u32::try_from(36_u64.saturating_add(data_bytes)).map_err(|_| {
    io::Error::new(
      io::ErrorKind::InvalidData,
      "recording is too large for a classic WAV file",
    )
  })?;
  let byte_rate = sample_rate
    .saturating_mul(channels as u32)
    .saturating_mul(WAV_BYTES_PER_SAMPLE as u32);
  let block_align = channels.saturating_mul(WAV_BYTES_PER_SAMPLE);

  file.seek(SeekFrom::Start(0))?;
  file.write_all(b"RIFF")?;
  file.write_all(&riff_size.to_le_bytes())?;
  file.write_all(b"WAVE")?;
  file.write_all(b"fmt ")?;
  file.write_all(&16_u32.to_le_bytes())?;
  file.write_all(&WAV_FLOAT_FORMAT_CODE.to_le_bytes())?;
  file.write_all(&channels.to_le_bytes())?;
  file.write_all(&sample_rate.to_le_bytes())?;
  file.write_all(&byte_rate.to_le_bytes())?;
  file.write_all(&block_align.to_le_bytes())?;
  file.write_all(&WAV_BITS_PER_SAMPLE.to_le_bytes())?;
  file.write_all(b"data")?;
  file.write_all(&data_size.to_le_bytes())?;
  file.seek(SeekFrom::End(0))?;
  Ok(())
}
