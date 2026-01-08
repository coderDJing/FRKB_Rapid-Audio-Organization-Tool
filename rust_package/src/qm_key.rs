use std::cmp::min;
use std::os::raw::{c_double, c_int};

use crate::analysis_utils::{calc_frames_to_process, to_stereo, K_ANALYSIS_FRAMES_PER_CHUNK};

#[repr(C)]
pub struct QmKeyDetectorHandle {
  _private: [u8; 0],
}

extern "C" {
  fn qm_key_create(sample_rate: c_double) -> *mut QmKeyDetectorHandle;
  fn qm_key_destroy(handle: *mut QmKeyDetectorHandle);
  fn qm_key_process(
    handle: *mut QmKeyDetectorHandle,
    interleaved: *const f32,
    frames: usize,
    channels: c_int,
  ) -> c_int;
  fn qm_key_finalize(handle: *mut QmKeyDetectorHandle) -> c_int;
}

pub struct KeyDetector {
  handle: *mut QmKeyDetectorHandle,
}

impl KeyDetector {
  pub fn new(sample_rate: u32) -> Result<Self, String> {
    let handle = unsafe { qm_key_create(sample_rate as f64) };
    if handle.is_null() {
      return Err("qm_key_create failed".to_string());
    }
    Ok(KeyDetector { handle })
  }

  pub fn process(
    &mut self,
    interleaved: &[f32],
    frames: usize,
    channels: u8,
  ) -> Result<(), String> {
    if self.handle.is_null() {
      return Err("qm_key_process failed".to_string());
    }
    if channels != 2 {
      return Err("channels is not 2".to_string());
    }
    let ok = unsafe { qm_key_process(self.handle, interleaved.as_ptr(), frames, channels as c_int) };
    if ok == 0 {
      return Err("qm_key_process failed".to_string());
    }
    Ok(())
  }

  pub fn finalize(&mut self) -> Result<i32, String> {
    if self.handle.is_null() {
      return Err("qm_key_finalize failed".to_string());
    }
    let key_id = unsafe { qm_key_finalize(self.handle) };
    Ok(key_id)
  }
}

impl Drop for KeyDetector {
  fn drop(&mut self) {
    if !self.handle.is_null() {
      unsafe { qm_key_destroy(self.handle) };
      self.handle = std::ptr::null_mut();
    }
  }
}

pub fn analyze_key_id_from_pcm(
  pcm_data: &[f32],
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> Result<i32, String> {
  if sample_rate == 0 {
    return Err("sample_rate is 0".to_string());
  }
  if channels == 0 {
    return Err("channels is 0".to_string());
  }

  let channels_usize = channels as usize;
  if pcm_data.is_empty() {
    return Err("pcm_data is empty".to_string());
  }

  let total_frames = pcm_data.len() / channels_usize;
  if total_frames == 0 {
    return Err("pcm_data has no frames".to_string());
  }

  let frames_to_process = calc_frames_to_process(total_frames, sample_rate, fast_analysis);
  if frames_to_process == 0 {
    return Err("frames_to_process is 0".to_string());
  }

  let needed_samples = frames_to_process * channels_usize;
  let pcm_slice = &pcm_data[..needed_samples];
  let stereo = to_stereo(pcm_slice, channels_usize, frames_to_process);
  let mut detector = KeyDetector::new(sample_rate)?;

  let stereo_samples = stereo.as_ref();
  let mut offset_frames = 0usize;
  while offset_frames < frames_to_process {
    let chunk_frames =
      min(K_ANALYSIS_FRAMES_PER_CHUNK, frames_to_process - offset_frames);
    let start = offset_frames * 2;
    let end = start + chunk_frames * 2;
    detector.process(&stereo_samples[start..end], chunk_frames, 2)?;
    offset_frames += chunk_frames;
  }

  let key_id = detector.finalize()?;
  Ok(key_id)
}
