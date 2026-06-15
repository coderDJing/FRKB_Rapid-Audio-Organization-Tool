use std::ffi::CString;
use std::os::raw::{c_char, c_double, c_int, c_void};
use std::path::Path;
use std::result::Result as StdResult;
use std::time::Instant;

extern "C" {
  fn frkb_ffmpeg_transport_decode(
    file_path: *const c_char,
    start_sec: c_double,
    max_duration_sec: c_double,
    target_sample_rate: c_int,
    target_channels: c_int,
    samples_out: *mut *mut i16,
    sample_count_out: *mut usize,
    sample_rate_out: *mut c_int,
    channels_out: *mut c_int,
    cancel_opaque: *mut c_void,
    should_cancel: Option<unsafe extern "C" fn(*mut c_void) -> c_int>,
  ) -> c_int;

  fn frkb_ffmpeg_transport_free_samples(ptr: *mut i16);
}

#[derive(Debug)]
pub(crate) struct FfmpegPcmData {
  pub(crate) samples_i16: Vec<i16>,
  pub(crate) sample_rate: u32,
  pub(crate) channels: u16,
  pub(crate) total_frames: u64,
}

#[derive(Debug)]
pub(crate) struct FfmpegTransportPcmData {
  pub(crate) samples_f32: Vec<f32>,
  pub(crate) sample_rate: u32,
  pub(crate) channels: u16,
  pub(crate) metrics: FfmpegTransportDecodeMetrics,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FfmpegTransportDecodeMetrics {
  pub(crate) total_ms: f64,
  pub(crate) spawn_ms: f64,
  pub(crate) first_byte_ms: Option<f64>,
  pub(crate) read_ms: f64,
  pub(crate) convert_ms: f64,
  pub(crate) wait_ms: f64,
  pub(crate) stderr_join_ms: f64,
  pub(crate) stdout_bytes: f64,
  pub(crate) read_iterations: f64,
}

pub(crate) const TRANSPORT_FFMPEG_SAMPLE_RATE: u32 = 44_100;
pub(crate) const TRANSPORT_FFMPEG_CHANNELS: u16 = 2;
const FRKB_ERR_CANCELLED: c_int = 11;

fn elapsed_ms(started_at: Instant) -> f64 {
  started_at.elapsed().as_secs_f64() * 1000.0
}

unsafe extern "C" fn cancel_trampoline<F>(opaque: *mut c_void) -> c_int
where
  F: Fn() -> bool,
{
  if opaque.is_null() {
    return 0;
  }
  let should_cancel = &*(opaque as *const F);
  if should_cancel() {
    1
  } else {
    0
  }
}

pub(crate) fn ffmpeg_decode_native_i16_cancellable<F>(
  path: &Path,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
  target_sample_rate: u32,
  target_channels: u16,
  should_cancel: F,
) -> StdResult<Option<(FfmpegPcmData, f64)>, String>
where
  F: Fn() -> bool,
{
  let c_path = CString::new(path.to_string_lossy().into_owned())
    .map_err(|_| "音频路径包含无效的 NUL 字符".to_string())?;
  let start_sec = start_sec
    .filter(|value| value.is_finite() && *value > 0.0)
    .unwrap_or(0.0);
  let max_duration_sec = max_duration_sec
    .filter(|value| value.is_finite() && *value > 0.0)
    .unwrap_or(0.0);

  let mut samples_ptr: *mut i16 = std::ptr::null_mut();
  let mut sample_count: usize = 0;
  let mut sample_rate: c_int = 0;
  let mut channels: c_int = 0;

  let native_started_at = Instant::now();
  let rc = unsafe {
    frkb_ffmpeg_transport_decode(
      c_path.as_ptr(),
      start_sec,
      max_duration_sec,
      target_sample_rate as c_int,
      target_channels as c_int,
      &mut samples_ptr,
      &mut sample_count,
      &mut sample_rate,
      &mut channels,
      &should_cancel as *const F as *mut c_void,
      Some(cancel_trampoline::<F>),
    )
  };
  let native_ms = elapsed_ms(native_started_at);

  if rc == FRKB_ERR_CANCELLED {
    unsafe { frkb_ffmpeg_transport_free_samples(samples_ptr) };
    return Ok(None);
  }
  if rc != 0 {
    return Err(format!("FFmpeg native transport 解码失败，错误码: {}", rc));
  }
  if sample_rate <= 0 {
    unsafe { frkb_ffmpeg_transport_free_samples(samples_ptr) };
    return Err("FFmpeg native transport 输出采样率无效".to_string());
  }
  if channels <= 0 {
    unsafe { frkb_ffmpeg_transport_free_samples(samples_ptr) };
    return Err("FFmpeg native transport 输出声道数无效".to_string());
  }
  if sample_count > 0 && samples_ptr.is_null() {
    return Err("FFmpeg native transport 输出样本指针为空".to_string());
  }

  let samples_i16 = if sample_count == 0 {
    Vec::new()
  } else {
    let samples = unsafe { std::slice::from_raw_parts(samples_ptr, sample_count) }.to_vec();
    unsafe { frkb_ffmpeg_transport_free_samples(samples_ptr) };
    samples
  };

  let total_frames = if channels <= 0 {
    0
  } else {
    samples_i16.len() as u64 / channels as u64
  };
  Ok(Some((
    FfmpegPcmData {
      samples_i16,
      sample_rate: sample_rate as u32,
      channels: channels as u16,
      total_frames,
    },
    native_ms,
  )))
}

pub(crate) fn ffmpeg_decode_native_i16(
  path: &Path,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
  target_sample_rate: u32,
  target_channels: u16,
) -> StdResult<(FfmpegPcmData, f64), String> {
  ffmpeg_decode_native_i16_cancellable(
    path,
    start_sec,
    max_duration_sec,
    target_sample_rate,
    target_channels,
    || false,
  )?
  .ok_or_else(|| "FFmpeg native transport 解码被取消".to_string())
}

pub(crate) fn ffmpeg_decode_native_f32(
  path: &Path,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
  target_sample_rate: u32,
  target_channels: u16,
) -> StdResult<(Vec<f32>, u32, u16, f64, f64), String> {
  ffmpeg_decode_native_f32_cancellable(
    path,
    start_sec,
    max_duration_sec,
    target_sample_rate,
    target_channels,
    || false,
  )?
  .ok_or_else(|| "FFmpeg native transport 解码被取消".to_string())
}

pub(crate) fn ffmpeg_decode_native_f32_cancellable<F>(
  path: &Path,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
  target_sample_rate: u32,
  target_channels: u16,
  should_cancel: F,
) -> StdResult<Option<(Vec<f32>, u32, u16, f64, f64)>, String>
where
  F: Fn() -> bool,
{
  let Some((decoded, native_ms)) = ffmpeg_decode_native_i16_cancellable(
    path,
    start_sec,
    max_duration_sec,
    target_sample_rate,
    target_channels,
    should_cancel,
  )?
  else {
    return Ok(None);
  };
  let convert_started_at = Instant::now();
  let samples_f32 = decoded
    .samples_i16
    .iter()
    .map(|sample| *sample as f32 / 32768.0)
    .collect();
  let convert_ms = elapsed_ms(convert_started_at);
  Ok(Some((
    samples_f32,
    decoded.sample_rate,
    decoded.channels,
    native_ms,
    convert_ms,
  )))
}

pub(crate) fn ffmpeg_decode_transport_native(
  path: &Path,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
) -> StdResult<FfmpegTransportPcmData, String> {
  ffmpeg_decode_transport_native_cancellable(path, start_sec, max_duration_sec, || false)?
    .ok_or_else(|| "FFmpeg native transport 解码被取消".to_string())
}

pub(crate) fn ffmpeg_decode_transport_native_cancellable<F>(
  path: &Path,
  start_sec: Option<f64>,
  max_duration_sec: Option<f64>,
  should_cancel: F,
) -> StdResult<Option<FfmpegTransportPcmData>, String>
where
  F: Fn() -> bool,
{
  let Some((samples_f32, sample_rate, channels, native_ms, convert_ms)) =
    ffmpeg_decode_native_f32_cancellable(
      path,
      start_sec,
      max_duration_sec,
      TRANSPORT_FFMPEG_SAMPLE_RATE,
      TRANSPORT_FFMPEG_CHANNELS,
      should_cancel,
    )?
  else {
    return Ok(None);
  };
  Ok(Some(FfmpegTransportPcmData {
    samples_f32,
    sample_rate,
    channels,
    metrics: FfmpegTransportDecodeMetrics {
      total_ms: native_ms + convert_ms,
      spawn_ms: 0.0,
      first_byte_ms: None,
      read_ms: native_ms,
      convert_ms,
      wait_ms: 0.0,
      stderr_join_ms: 0.0,
      stdout_bytes: 0.0,
      read_iterations: 0.0,
    },
  }))
}

#[cfg(test)]
fn append_raw_s16le_to_f32(
  bytes: &[u8],
  pending_byte: &mut Option<u8>,
  samples_f32: &mut Vec<f32>,
) {
  let mut offset = 0;
  if let Some(first) = pending_byte.take() {
    if let Some(second) = bytes.first() {
      let sample = i16::from_le_bytes([first, *second]);
      samples_f32.push(sample as f32 / 32768.0);
      offset = 1;
    } else {
      *pending_byte = Some(first);
      return;
    }
  }

  let mut chunks = bytes[offset..].chunks_exact(2);
  for chunk in &mut chunks {
    let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
    samples_f32.push(sample as f32 / 32768.0);
  }
  let remainder = chunks.remainder();
  if let Some(remainder_byte) = remainder.first() {
    *pending_byte = Some(*remainder_byte);
  }
}

#[cfg(test)]
fn parse_raw_s16le_to_f32(
  bytes: Vec<u8>,
  sample_rate: u32,
  channels: u16,
) -> StdResult<FfmpegTransportPcmData, String> {
  if sample_rate == 0 {
    return Err("FFmpeg raw PCM 采样率无效".to_string());
  }
  if channels == 0 {
    return Err("FFmpeg raw PCM 声道数无效".to_string());
  }
  if bytes.len() % 2 != 0 {
    return Err("FFmpeg raw PCM 输出长度不是 16bit 对齐".to_string());
  }

  let mut samples_f32 = Vec::with_capacity(bytes.len() / 2);
  let mut pending_byte = None;
  append_raw_s16le_to_f32(&bytes, &mut pending_byte, &mut samples_f32);
  Ok(FfmpegTransportPcmData {
    samples_f32,
    sample_rate,
    channels,
    metrics: FfmpegTransportDecodeMetrics::default(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_raw_s16le_to_f32_builds_pcm_metadata_from_fixed_transport_format() {
    let parsed = parse_raw_s16le_to_f32(
      vec![0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff],
      44_100,
      2,
    )
    .unwrap();

    assert_eq!(parsed.samples_f32[0], 0.0);
    assert!((parsed.samples_f32[1] - (i16::MAX as f32 / 32768.0)).abs() < f32::EPSILON);
    assert_eq!(parsed.samples_f32[2], -1.0);
    assert!((parsed.samples_f32[3] - (-1.0 / 32768.0)).abs() < f32::EPSILON);
    assert_eq!(parsed.sample_rate, 44_100);
    assert_eq!(parsed.channels, 2);
    assert_eq!(parsed.samples_f32.len() / parsed.channels as usize, 2);
  }

  #[test]
  fn parse_raw_s16le_to_f32_rejects_unaligned_output() {
    let error = parse_raw_s16le_to_f32(vec![0x00], 44_100, 2).unwrap_err();

    assert!(error.contains("16bit"));
  }

  #[test]
  fn append_raw_s16le_to_f32_handles_split_samples() {
    let mut pending_byte = None;
    let mut samples = Vec::new();

    append_raw_s16le_to_f32(&[0xff], &mut pending_byte, &mut samples);
    assert_eq!(samples.len(), 0);
    assert_eq!(pending_byte, Some(0xff));

    append_raw_s16le_to_f32(&[0x7f, 0x00, 0x80], &mut pending_byte, &mut samples);
    assert_eq!(pending_byte, None);
    assert!((samples[0] - (i16::MAX as f32 / 32768.0)).abs() < f32::EPSILON);
    assert_eq!(samples[1], -1.0);
  }
}
