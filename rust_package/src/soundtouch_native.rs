use std::ffi::c_void;

const ST_SETTING_USE_QUICKSEEK: i32 = 2;
const MIN_RATE: f64 = 0.25;
const MAX_RATE: f64 = 4.0;
const RECEIVE_CHUNK_FRAMES: usize = 4096;

unsafe extern "C" {
  fn frkb_soundtouch_create() -> *mut c_void;
  fn frkb_soundtouch_destroy(handle: *mut c_void);
  fn frkb_soundtouch_set_channels(handle: *mut c_void, channels: u32);
  fn frkb_soundtouch_set_sample_rate(handle: *mut c_void, sample_rate: u32);
  fn frkb_soundtouch_set_tempo(handle: *mut c_void, tempo: f64);
  fn frkb_soundtouch_set_pitch(handle: *mut c_void, pitch: f64);
  fn frkb_soundtouch_set_rate(handle: *mut c_void, rate: f64);
  fn frkb_soundtouch_set_setting(handle: *mut c_void, setting_id: i32, value: i32);
  fn frkb_soundtouch_put_samples(handle: *mut c_void, samples: *const f32, num_samples: u32);
  fn frkb_soundtouch_receive_samples(
    handle: *mut c_void,
    output: *mut f32,
    max_samples: u32,
  ) -> u32;
  fn frkb_soundtouch_flush(handle: *mut c_void);
}

fn clamp_rate(value: f64) -> f64 {
  if value.is_finite() && value > 0.0 {
    value.clamp(MIN_RATE, MAX_RATE)
  } else {
    1.0
  }
}

pub(crate) struct SoundTouchHandle(*mut c_void);

unsafe impl Send for SoundTouchHandle {}

impl SoundTouchHandle {
  pub(crate) fn new(channels: u32, sample_rate: u32, tempo: f64) -> Option<Self> {
    let handle = unsafe { frkb_soundtouch_create() };
    if handle.is_null() {
      return None;
    }
    unsafe {
      frkb_soundtouch_set_channels(handle, channels);
      frkb_soundtouch_set_sample_rate(handle, sample_rate);
      frkb_soundtouch_set_tempo(handle, tempo);
      frkb_soundtouch_set_pitch(handle, 1.0);
      frkb_soundtouch_set_rate(handle, 1.0);
      frkb_soundtouch_set_setting(handle, ST_SETTING_USE_QUICKSEEK, 1);
    }
    Some(Self(handle))
  }

  pub(crate) fn put_samples(&mut self, samples: &[f32], num_samples: usize) {
    if samples.is_empty() || num_samples == 0 {
      return;
    }
    unsafe { frkb_soundtouch_put_samples(self.0, samples.as_ptr(), num_samples as u32) }
  }

  pub(crate) fn receive_samples(&mut self, output: &mut [f32], max_samples: usize) -> usize {
    if output.is_empty() || max_samples == 0 {
      return 0;
    }
    unsafe {
      frkb_soundtouch_receive_samples(self.0, output.as_mut_ptr(), max_samples as u32) as usize
    }
  }

  pub(crate) fn flush(&mut self) {
    unsafe { frkb_soundtouch_flush(self.0) }
  }
}

impl Drop for SoundTouchHandle {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { frkb_soundtouch_destroy(self.0) }
      self.0 = std::ptr::null_mut();
    }
  }
}

pub(crate) fn process_interleaved_f32(
  samples: &[f32],
  sample_rate: u32,
  channels: usize,
  tempo: f64,
) -> Result<Vec<f32>, String> {
  let safe_channels = channels.max(1);
  if sample_rate == 0 {
    return Err("sample_rate is 0".to_string());
  }
  if samples.is_empty() {
    return Ok(Vec::new());
  }
  let safe_tempo = clamp_rate(tempo);
  if (safe_tempo - 1.0).abs() <= 0.0001 {
    return Ok(samples.to_vec());
  }
  let mut processor = SoundTouchHandle::new(safe_channels as u32, sample_rate, safe_tempo)
    .ok_or_else(|| "create soundtouch failed".to_string())?;
  processor.put_samples(samples, samples.len() / safe_channels);

  let mut output = Vec::<f32>::with_capacity(
    ((samples.len() as f64 / safe_tempo.max(0.01)) as usize).saturating_add(safe_channels * 1024),
  );
  let mut chunk = vec![0.0_f32; safe_channels * RECEIVE_CHUNK_FRAMES];

  loop {
    let received = processor.receive_samples(&mut chunk, RECEIVE_CHUNK_FRAMES);
    if received == 0 {
      break;
    }
    output.extend_from_slice(&chunk[..received * safe_channels]);
  }

  processor.flush();

  loop {
    let received = processor.receive_samples(&mut chunk, RECEIVE_CHUNK_FRAMES);
    if received == 0 {
      break;
    }
    output.extend_from_slice(&chunk[..received * safe_channels]);
  }

  Ok(output)
}
