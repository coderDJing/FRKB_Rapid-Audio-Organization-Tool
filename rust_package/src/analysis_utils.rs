use std::borrow::Cow;

pub const K_ANALYSIS_FRAMES_PER_CHUNK: usize = 4096;
pub const K_FAST_ANALYSIS_SECONDS: usize = 60;

pub fn calc_frames_to_process(
  total_frames: usize,
  sample_rate: u32,
  fast_analysis: bool,
) -> usize {
  if sample_rate == 0 {
    return 0;
  }
  if !fast_analysis {
    return total_frames;
  }
  let max_frames = (sample_rate as usize).saturating_mul(K_FAST_ANALYSIS_SECONDS);
  std::cmp::min(total_frames, max_frames)
}

pub fn to_stereo(pcm: &[f32], channels: usize, frames: usize) -> Cow<'_, [f32]> {
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
