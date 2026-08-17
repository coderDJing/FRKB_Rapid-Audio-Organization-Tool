use bytemuck::cast_slice;
use napi::bindgen_prelude::Buffer;

use super::horizontal_browse_transport_r3_stretch::R3MasterTempoProcessor;
use super::R3MasterTempoOfflineResult;

const MAX_INPUT_FRAMES: usize = u32::MAX as usize;
const RETRIEVE_FRAMES: usize = 65_536;

pub(super) fn process_r3_master_tempo_offline(
  pcm_bytes: &[u8],
  sample_rate: u32,
  channels: u32,
  tempo: f64,
  mode: &str,
) -> napi::Result<R3MasterTempoOfflineResult> {
  if sample_rate == 0 {
    return Err(napi::Error::from_reason(
      "sample rate must be greater than zero",
    ));
  }
  if !(1..=2).contains(&channels) {
    return Err(napi::Error::from_reason("channels must be 1 or 2"));
  }
  if !tempo.is_finite() || !(0.25..=4.0).contains(&tempo) {
    return Err(napi::Error::from_reason(
      "tempo must be finite and between 0.25 and 4.0",
    ));
  }
  if pcm_bytes.len() % std::mem::size_of::<f32>() != 0 {
    return Err(napi::Error::from_reason(
      "PCM byte length must be aligned to float32 samples",
    ));
  }

  let samples = pcm_bytes
    .chunks_exact(4)
    .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    .collect::<Vec<_>>();
  let channels_usize = channels as usize;
  if samples.is_empty() || samples.len() % channels_usize != 0 {
    return Err(napi::Error::from_reason(
      "PCM samples must contain complete interleaved frames",
    ));
  }
  let input_frames = samples.len() / channels_usize;
  if input_frames > MAX_INPUT_FRAMES {
    return Err(napi::Error::from_reason("PCM input is too large"));
  }

  let mode_code = match mode {
    "r3-mw" => 0,
    "r3-sw" => 1,
    "faster" => 2,
    _ => {
      return Err(napi::Error::from_reason(
        "mode must be r3-mw, r3-sw, or faster",
      ))
    }
  };
  let mut processor =
    R3MasterTempoProcessor::new_with_mode(channels, sample_rate, tempo, mode_code)
      .ok_or_else(|| napi::Error::from_reason("R3 Master Tempo processor is unavailable"))?;
  let engine_version = processor.engine_version();
  let preferred_start_pad = processor.preferred_start_pad();
  let start_delay = processor.start_delay();
  let mut input_cursor = 0_usize;
  let mut output = Vec::<f32>::with_capacity(
    ((input_frames as f64 / tempo).ceil() as usize).saturating_mul(channels_usize),
  );
  let mut retrieve_buffer = vec![0.0_f32; RETRIEVE_FRAMES * channels_usize];
  let mut feed_calls = 0_u32;
  let mut retrieve_calls = 0_u32;
  let mut zero_retrieve_calls = 0_u32;

  while input_cursor < input_frames {
    let required = processor.input_frames_required();
    if required > 0 {
      let frames = required.min(input_frames - input_cursor);
      let start = input_cursor * channels_usize;
      let end = start + frames * channels_usize;
      if !processor.process_interleaved(&samples[start..end], frames) {
        return Err(napi::Error::from_reason("R3 rejected an input PCM block"));
      }
      input_cursor += frames;
      feed_calls = feed_calls.saturating_add(1);
    }
    let received = processor.retrieve_interleaved(&mut retrieve_buffer, RETRIEVE_FRAMES);
    retrieve_calls = retrieve_calls.saturating_add(1);
    if received == 0 {
      zero_retrieve_calls = zero_retrieve_calls.saturating_add(1);
    } else {
      output.extend_from_slice(&retrieve_buffer[..received * channels_usize]);
    }
  }

  processor.finish();
  loop {
    let received = processor.retrieve_interleaved(&mut retrieve_buffer, RETRIEVE_FRAMES);
    retrieve_calls = retrieve_calls.saturating_add(1);
    if received == 0 {
      break;
    }
    output.extend_from_slice(&retrieve_buffer[..received * channels_usize]);
  }

  let output_frames = output.len() / channels_usize;
  if output_frames > u32::MAX as usize {
    return Err(napi::Error::from_reason("R3 output is too large"));
  }
  Ok(R3MasterTempoOfflineResult {
    pcm_data: Buffer::from(cast_slice(&output).to_vec()),
    mode: mode.to_owned(),
    engine_version,
    input_frames: input_frames as u32,
    output_frames: output_frames as u32,
    preferred_start_pad,
    start_delay,
    feed_calls,
    retrieve_calls,
    zero_retrieve_calls,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn offline_processor_returns_expected_duration_and_metadata() {
    if std::env::var_os("FRKB_R3_STRETCH_LIBRARY").is_none() {
      return;
    }
    let sample_rate = 44_100_u32;
    let channels = 2_u32;
    let tempo = 134.0 / 131.0;
    let frames = sample_rate as usize * 2;
    let mut samples = Vec::with_capacity(frames * channels as usize);
    for frame in 0..frames {
      let sample = (std::f64::consts::TAU * 110.0 * frame as f64 / sample_rate as f64).sin() as f32;
      samples.extend_from_slice(&[sample, sample]);
    }
    let result =
      process_r3_master_tempo_offline(cast_slice(&samples), sample_rate, channels, tempo, "r3-mw")
        .unwrap();
    let expected_frames = frames as f64 / tempo;
    assert!((result.output_frames as f64 - expected_frames).abs() < sample_rate as f64 * 0.1);
    assert_eq!(result.input_frames, frames as u32);
    assert!(result.feed_calls > 0);
    assert!(result.retrieve_calls > 0);
    assert!(!result.pcm_data.is_empty());
  }
}
