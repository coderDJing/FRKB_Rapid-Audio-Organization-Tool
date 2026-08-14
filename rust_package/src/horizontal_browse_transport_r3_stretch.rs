use std::ffi::c_void;

unsafe extern "C" {
  fn frkb_r3_stretch_create(channels: u32, sample_rate: u32, tempo: f64) -> *mut c_void;
  fn frkb_r3_stretch_destroy(handle: *mut c_void);
  fn frkb_r3_stretch_reset(handle: *mut c_void, tempo: f64);
  fn frkb_r3_stretch_engine_version(handle: *mut c_void) -> i32;
  fn frkb_r3_stretch_set_tempo(handle: *mut c_void, tempo: f64);
  fn frkb_r3_stretch_get_samples_required(handle: *mut c_void) -> u32;
  fn frkb_r3_stretch_process_interleaved(
    handle: *mut c_void,
    input: *const f32,
    frames: u32,
  ) -> i32;
  fn frkb_r3_stretch_retrieve_interleaved(
    handle: *mut c_void,
    output: *mut f32,
    max_frames: u32,
  ) -> u32;
  fn frkb_r3_stretch_finish(handle: *mut c_void);
}

pub(super) struct R3MasterTempoProcessor(*mut c_void);

unsafe impl Send for R3MasterTempoProcessor {}

impl R3MasterTempoProcessor {
  pub(super) fn new(channels: u32, sample_rate: u32, tempo: f64) -> Option<Self> {
    let handle = unsafe { frkb_r3_stretch_create(channels, sample_rate, tempo) };
    if handle.is_null() {
      return None;
    }
    let processor = Self(handle);
    if processor.engine_version() != 3 {
      return None;
    }
    Some(processor)
  }

  pub(super) fn engine_version(&self) -> i32 {
    unsafe { frkb_r3_stretch_engine_version(self.0) }
  }

  pub(super) fn reset(&mut self, tempo: f64) {
    unsafe { frkb_r3_stretch_reset(self.0, tempo) }
  }

  pub(super) fn set_tempo(&mut self, tempo: f64) {
    unsafe { frkb_r3_stretch_set_tempo(self.0, tempo) }
  }

  pub(super) fn input_frames_required(&self) -> usize {
    unsafe { frkb_r3_stretch_get_samples_required(self.0) as usize }
  }

  pub(super) fn process_interleaved(&mut self, input: &[f32], frames: usize) -> bool {
    if input.is_empty() || frames == 0 || frames > u32::MAX as usize {
      return false;
    }
    unsafe { frkb_r3_stretch_process_interleaved(self.0, input.as_ptr(), frames as u32) != 0 }
  }

  pub(super) fn retrieve_interleaved(&mut self, output: &mut [f32], max_frames: usize) -> usize {
    if output.is_empty() || max_frames == 0 {
      return 0;
    }
    unsafe {
      frkb_r3_stretch_retrieve_interleaved(self.0, output.as_mut_ptr(), max_frames as u32) as usize
    }
  }

  pub(super) fn finish(&mut self) {
    unsafe { frkb_r3_stretch_finish(self.0) }
  }
}

impl Drop for R3MasterTempoProcessor {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { frkb_r3_stretch_destroy(self.0) }
      self.0 = std::ptr::null_mut();
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn r3_streaming_contract_produces_aligned_stereo_output() {
    if std::env::var_os("FRKB_R3_STRETCH_LIBRARY").is_none() {
      return;
    }

    let sample_rate = 48_000_u32;
    let tempo = 134.0 / 131.0;
    let input_frames = sample_rate as usize * 2;
    let mut input = vec![0.0_f32; input_frames * 2];
    for frame in 0..input_frames {
      let phase = std::f64::consts::TAU * 110.0 * frame as f64 / sample_rate as f64;
      let pulse = if frame % 24_000 < 480 {
        (-((frame % 24_000) as f64) / 120.0).exp() as f32
      } else {
        0.0
      };
      let sample = phase.sin() as f32 * 0.2 + pulse * 0.8;
      input[frame * 2] = sample;
      input[frame * 2 + 1] = sample;
    }

    let mut processor = R3MasterTempoProcessor::new(2, sample_rate, tempo).unwrap();
    assert_eq!(processor.engine_version(), 3);
    processor.reset(tempo);
    assert_eq!(processor.engine_version(), 3);
    let mut input_cursor = 0_usize;
    let mut output = vec![0.0_f32; 8192];
    let output_capacity_frames = output.len() / 2;
    let mut output_frames = 0_usize;
    let mut output_energy = 0.0_f64;

    while input_cursor < input_frames {
      let required = processor.input_frames_required();
      if required > 0 {
        let frames = required.min(input_frames - input_cursor);
        let start = input_cursor * 2;
        let end = start + frames * 2;
        assert!(processor.process_interleaved(&input[start..end], frames));
        input_cursor += frames;
      }
      let received = processor.retrieve_interleaved(&mut output, output_capacity_frames);
      output_frames += received;
      output_energy += output[..received * 2]
        .iter()
        .map(|sample| (*sample as f64).abs())
        .sum::<f64>();
    }

    processor.finish();
    for _ in 0..128 {
      let received = processor.retrieve_interleaved(&mut output, output_capacity_frames);
      if received == 0 {
        break;
      }
      output_frames += received;
      output_energy += output[..received * 2]
        .iter()
        .map(|sample| (*sample as f64).abs())
        .sum::<f64>();
    }

    let expected_frames = input_frames as f64 / tempo;
    assert!((output_frames as f64 - expected_frames).abs() < sample_rate as f64 * 0.1);
    assert!(output_energy > 100.0);
  }
}
