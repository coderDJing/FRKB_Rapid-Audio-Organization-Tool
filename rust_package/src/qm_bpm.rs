use std::os::raw::{c_double, c_int};

#[repr(C)]
pub struct QmBpmDetectorHandle {
  _private: [u8; 0],
}

extern "C" {
  fn qm_bpm_create(sample_rate: c_double) -> *mut QmBpmDetectorHandle;
  fn qm_bpm_destroy(handle: *mut QmBpmDetectorHandle);
  fn qm_bpm_process(
    handle: *mut QmBpmDetectorHandle,
    interleaved: *const f32,
    frames: usize,
    channels: c_int,
  ) -> c_int;
  fn qm_bpm_finalize(handle: *mut QmBpmDetectorHandle) -> c_double;
  fn qm_bpm_first_beat_frame(handle: *mut QmBpmDetectorHandle) -> c_double;
}

pub struct BpmFinalizeResult {
  pub bpm: f64,
  pub first_beat_frame: Option<f64>,
}

pub struct BpmDetector {
  handle: *mut QmBpmDetectorHandle,
}

impl BpmDetector {
  pub fn new(sample_rate: u32) -> Result<Self, String> {
    let handle = unsafe { qm_bpm_create(sample_rate as f64) };
    if handle.is_null() {
      return Err("qm_bpm_create failed".to_string());
    }
    Ok(BpmDetector { handle })
  }

  pub fn process(
    &mut self,
    interleaved: &[f32],
    frames: usize,
    channels: u8,
  ) -> Result<(), String> {
    if self.handle.is_null() {
      return Err("qm_bpm_process failed".to_string());
    }
    if channels != 2 {
      return Err("channels is not 2".to_string());
    }
    let ok = unsafe { qm_bpm_process(self.handle, interleaved.as_ptr(), frames, channels as c_int) };
    if ok == 0 {
      return Err("qm_bpm_process failed".to_string());
    }
    Ok(())
  }

  pub fn finalize(&mut self) -> Result<BpmFinalizeResult, String> {
    if self.handle.is_null() {
      return Err("qm_bpm_finalize failed".to_string());
    }
    let bpm = unsafe { qm_bpm_finalize(self.handle) };
    let first_beat_frame = unsafe { qm_bpm_first_beat_frame(self.handle) };
    let resolved_first_beat_frame = if first_beat_frame.is_finite() && first_beat_frame >= 0.0 {
      Some(first_beat_frame)
    } else {
      None
    };
    Ok(BpmFinalizeResult {
      bpm,
      first_beat_frame: resolved_first_beat_frame,
    })
  }
}

impl Drop for BpmDetector {
  fn drop(&mut self) {
    if !self.handle.is_null() {
      unsafe { qm_bpm_destroy(self.handle) };
      self.handle = std::ptr::null_mut();
    }
  }
}
