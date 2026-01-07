use std::borrow::Cow;
use std::cmp::min;
use std::os::raw::{c_double, c_int};

const K_ANALYSIS_FRAMES_PER_CHUNK: usize = 4096;
const K_FAST_ANALYSIS_SECONDS: usize = 60;

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

struct DetectorGuard(*mut QmKeyDetectorHandle);

impl Drop for DetectorGuard {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { qm_key_destroy(self.0) };
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

  let max_frames = if fast_analysis {
    (sample_rate as usize).saturating_mul(K_FAST_ANALYSIS_SECONDS)
  } else {
    total_frames
  };
  let frames_to_process = min(total_frames, max_frames);
  if frames_to_process == 0 {
    return Err("frames_to_process is 0".to_string());
  }

  let needed_samples = frames_to_process * channels_usize;
  let pcm_slice = &pcm_data[..needed_samples];
  let stereo = to_stereo(pcm_slice, channels_usize, frames_to_process);

  let handle = unsafe { qm_key_create(sample_rate as f64) };
  if handle.is_null() {
    return Err("qm_key_create failed".to_string());
  }
  let _guard = DetectorGuard(handle);

  let stereo_samples = stereo.as_ref();
  let mut offset_frames = 0usize;
  while offset_frames < frames_to_process {
    let chunk_frames =
      min(K_ANALYSIS_FRAMES_PER_CHUNK, frames_to_process - offset_frames);
    let start = offset_frames * 2;
    let end = start + chunk_frames * 2;
    let ok = unsafe {
      qm_key_process(handle, stereo_samples[start..end].as_ptr(), chunk_frames, 2)
    };
    if ok == 0 {
      return Err("qm_key_process failed".to_string());
    }
    offset_frames += chunk_frames;
  }

  let key_id = unsafe { qm_key_finalize(handle) };
  Ok(key_id)
}

fn to_stereo(pcm: &[f32], channels: usize, frames: usize) -> Cow<'_, [f32]> {
  if channels == 2 {
    return Cow::Borrowed(&pcm[..frames * 2]);
  }

  let mut out = Vec::with_capacity(frames * 2);
  if channels == 1 {
    for frame in 0..frames {
      let v = pcm[frame];
      out.push(v);
      out.push(v);
    }
    return Cow::Owned(out);
  }

  for frame in 0..frames {
    let mut sum = 0.0f32;
    let base = frame * channels;
    for ch in 0..channels {
      sum += pcm[base + ch];
    }
    let avg = sum / channels as f32;
    out.push(avg);
    out.push(avg);
  }
  Cow::Owned(out)
}
