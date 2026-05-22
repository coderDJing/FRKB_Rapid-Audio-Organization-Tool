use super::{
  HorizontalBrowseTransportVisualizerSnapshot, HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT,
};

pub(super) fn push_visualizer_sample(
  ring: &mut Vec<f32>,
  write_index: &mut usize,
  filled: &mut bool,
  sample: f32,
) {
  if ring.len() != HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT {
    *ring = vec![0.0; HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT];
    *write_index = 0;
    *filled = false;
  }
  if ring.is_empty() {
    return;
  }
  ring[*write_index] = sample.clamp(-1.0, 1.0);
  *write_index = (*write_index + 1) % HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT;
  if *write_index == 0 {
    *filled = true;
  }
}

pub(super) fn visualizer_snapshot(
  ring: &[f32],
  write_index: usize,
  filled: bool,
) -> HorizontalBrowseTransportVisualizerSnapshot {
  let sample_count = HORIZONTAL_BROWSE_VISUALIZER_SAMPLE_COUNT;
  if ring.len() != sample_count {
    return HorizontalBrowseTransportVisualizerSnapshot {
      time_domain_data: vec![128; sample_count],
    };
  }
  let available = if filled {
    sample_count
  } else {
    write_index.min(sample_count)
  };
  let mut time_domain_data = Vec::with_capacity(sample_count);
  for _ in available..sample_count {
    time_domain_data.push(128);
  }
  if available == 0 {
    return HorizontalBrowseTransportVisualizerSnapshot { time_domain_data };
  }
  let start_index = if filled { write_index } else { 0 };
  for offset in 0..available {
    let index = (start_index + offset) % sample_count;
    let sample = ring.get(index).copied().unwrap_or(0.0);
    let encoded = ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * 255.0).round() as i32;
    time_domain_data.push(encoded.clamp(0, 255) as u8);
  }
  HorizontalBrowseTransportVisualizerSnapshot { time_domain_data }
}
