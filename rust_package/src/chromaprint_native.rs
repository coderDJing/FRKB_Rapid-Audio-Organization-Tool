use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_void};

extern "C" {
  fn frkb_chromaprint_generate(
    samples_i16: *const i16,
    num_samples: c_int,
    sample_rate: c_int,
    num_channels: c_int,
    max_seconds: c_int,
    fingerprint_out: *mut *mut c_char,
    duration_out: *mut c_double,
  ) -> c_int;

  fn frkb_chromaprint_free_string(ptr: *mut c_char);

  fn frkb_ffmpeg_decode_to_i16(
    file_path: *const c_char,
    max_duration_sec: c_int,
    samples_out: *mut *mut i16,
    num_samples_out: *mut c_int,
    sample_rate_out: *mut c_int,
    num_channels_out: *mut c_int,
  ) -> c_int;

  fn frkb_ffmpeg_chromaprint_generate(
    file_path: *const c_char,
    max_duration_sec: c_int,
    fingerprint_out: *mut *mut c_char,
    duration_out: *mut c_double,
  ) -> c_int;

  fn frkb_ffmpeg_free_buffer(ptr: *mut c_void);
}

pub struct ChromaprintResult {
  pub fingerprint: String,
  pub duration: f64,
}

pub fn generate_fingerprint_from_i16(
  samples_i16: &[i16],
  sample_rate: u32,
  num_channels: u16,
  max_seconds: u32,
) -> Result<ChromaprintResult, String> {
  if samples_i16.is_empty() {
    return Err("samples_i16 is empty".to_string());
  }
  if sample_rate == 0 {
    return Err("sample_rate is 0".to_string());
  }
  if num_channels != 1 && num_channels != 2 {
    return Err("num_channels must be 1 or 2".to_string());
  }

  let mut fp_ptr: *mut c_char = std::ptr::null_mut();
  let mut duration: c_double = 0.0;

  let rc = unsafe {
    frkb_chromaprint_generate(
      samples_i16.as_ptr(),
      samples_i16.len() as c_int,
      sample_rate as c_int,
      num_channels as c_int,
      max_seconds as c_int,
      &mut fp_ptr,
      &mut duration,
    )
  };

  if rc != 0 {
    return Err(format!("frkb_chromaprint_generate failed with code {}", rc));
  }

  if fp_ptr.is_null() {
    return Err("fingerprint pointer is null".to_string());
  }

  let fingerprint = unsafe { CStr::from_ptr(fp_ptr) }
    .to_str()
    .map_err(|e| format!("invalid UTF-8: {}", e))?
    .to_string();

  unsafe { frkb_chromaprint_free_string(fp_ptr) };

  Ok(ChromaprintResult {
    fingerprint,
    duration,
  })
}

pub fn generate_fingerprint_from_f32(
  pcm_f32: &[f32],
  sample_rate: u32,
  num_channels: u16,
  max_seconds: u32,
) -> Result<ChromaprintResult, String> {
  if pcm_f32.is_empty() {
    return Err("pcm_f32 is empty".to_string());
  }

  let i16_data: Vec<i16> = pcm_f32
    .iter()
    .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
    .collect();

  generate_fingerprint_from_i16(&i16_data, sample_rate, num_channels, max_seconds)
}

/// Generate a Chromaprint fingerprint by decoding a file directly with FFmpeg libavcodec.
/// This is the fastest path: decode + fingerprint in one pass, no subprocess overhead.
pub fn generate_fingerprint_from_file(
  file_path: &str,
  max_seconds: u32,
) -> Result<ChromaprintResult, String> {
  let c_path = CString::new(file_path).map_err(|_| "invalid file path".to_string())?;

  let mut fp_ptr: *mut c_char = std::ptr::null_mut();
  let mut duration: c_double = 0.0;

  let rc = unsafe {
    frkb_ffmpeg_chromaprint_generate(
      c_path.as_ptr(),
      max_seconds as c_int,
      &mut fp_ptr,
      &mut duration,
    )
  };

  if rc != 0 {
    return Err(format!("frkb_ffmpeg_chromaprint_generate failed with code {}", rc));
  }

  if fp_ptr.is_null() {
    return Err("fingerprint pointer is null".to_string());
  }

  let fingerprint = unsafe { CStr::from_ptr(fp_ptr) }
    .to_str()
    .map_err(|e| format!("invalid UTF-8: {}", e))?
    .to_string();

  unsafe { frkb_chromaprint_free_string(fp_ptr) };

  Ok(ChromaprintResult {
    fingerprint,
    duration,
  })
}

/// Decode a file to i16 PCM using FFmpeg libavcodec.
/// Returns (samples_i16, sample_rate, num_channels).
#[allow(dead_code)]
pub fn decode_file_to_i16(
  file_path: &str,
  max_duration_sec: u32,
) -> Result<(Vec<i16>, u32, u16), String> {
  let c_path = CString::new(file_path).map_err(|_| "invalid file path".to_string())?;

  let mut samples_ptr: *mut i16 = std::ptr::null_mut();
  let mut num_samples: c_int = 0;
  let mut sample_rate: c_int = 0;
  let mut num_channels: c_int = 0;

  let rc = unsafe {
    frkb_ffmpeg_decode_to_i16(
      c_path.as_ptr(),
      max_duration_sec as c_int,
      &mut samples_ptr,
      &mut num_samples,
      &mut sample_rate,
      &mut num_channels,
    )
  };

  if rc != 0 {
    return Err(format!("frkb_ffmpeg_decode_to_i16 failed with code {}", rc));
  }

  if samples_ptr.is_null() {
    return Err("samples pointer is null".to_string());
  }

  let total = (num_samples as usize) * (num_channels as usize);
  let samples = unsafe { std::slice::from_raw_parts(samples_ptr, total) }.to_vec();
  unsafe { frkb_ffmpeg_free_buffer(samples_ptr as *mut c_void) };

  Ok((samples, sample_rate as u32, num_channels as u16))
}
