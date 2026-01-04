use bytemuck::cast_slice;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tract_onnx::tract_hir::infer::Factoid;
use tract_onnx::prelude::*;

const ENV_OPENL3_MODEL_PATH: &str = "FRKB_OPENL3_MODEL_PATH";

const TARGET_SAMPLE_RATE: u32 = 48_000;
const WINDOW_SECONDS: f32 = 1.0;
const HOP_SECONDS: f32 = 0.1;

const DEFAULT_MAX_SECONDS: f64 = 120.0;
const DEFAULT_MAX_WINDOWS: usize = 200;
const DEFAULT_BATCH: usize = 16;

const FEATURE_SEGMENT_SECONDS: f32 = 12.0;
const FEATURE_SEGMENT_HOP_SECONDS: f32 = 4.0;
const FEATURE_SEGMENT_COUNT: usize = 3;
const FEATURE_SEGMENT_EDGE_GUARD_SECONDS: f32 = 6.0;
const FEATURE_SEGMENT_MIN_GAP_RATIO: f32 = 0.6;

// OpenL3 (kapre) 常见参数：n_fft=512, hop=242 时 1s @48kHz 输出 199 帧
const N_FFT: usize = 512;
const HOP_LENGTH: usize = 242;
const N_MELS: usize = 256;

#[derive(Clone, Copy, Debug)]
struct InputLayout {
  rank: usize,
  batch_axis: usize,
  frames_axis: usize,
  mel_axis: usize,
  channel_axis: Option<usize>,
}

struct OpenL3Runtime {
  plan: TypedRunnableModel<TypedModel>,
  layout: InputLayout,
  embedding_dim: usize,
  mel_filters: Vec<Vec<(usize, f32)>>,
  window_fn: Vec<f32>,
  fft: Arc<dyn Fft<f32>>,
}

#[derive(Clone, Copy, Debug)]
struct FeatureSegment {
  start: usize,
  end: usize,
  rms: f32,
}

static OPENL3_RUNTIME: OnceLock<Mutex<Option<(String, Arc<OpenL3Runtime>)>>> = OnceLock::new();

pub fn extract_openl3_embedding(
  file_path: &str,
  max_seconds: Option<f64>,
  max_windows: Option<usize>,
) -> Result<Vec<f32>, String> {
  let model_path = std::env::var(ENV_OPENL3_MODEL_PATH).unwrap_or_default();
  if model_path.trim().is_empty() {
    return Err("runtime_unavailable: 缺少 FRKB_OPENL3_MODEL_PATH".to_string());
  }
  let rt = get_runtime(&model_path)?;

  let max_seconds = max_seconds.unwrap_or(DEFAULT_MAX_SECONDS);
  let max_windows = max_windows.unwrap_or(DEFAULT_MAX_WINDOWS).max(1);

  let (mut mono, sr) = decode_mono_limited(file_path, max_seconds)?;
  if mono.is_empty() {
    return Err("音频为空".to_string());
  }
  if sr != TARGET_SAMPLE_RATE {
    mono = resample_linear(&mono, sr, TARGET_SAMPLE_RATE);
  }

  let window_len = (WINDOW_SECONDS * TARGET_SAMPLE_RATE as f32).round().max(1.0) as usize;
  let hop_len = (HOP_SECONDS * TARGET_SAMPLE_RATE as f32).round().max(1.0) as usize;

  // 片段联动：基于高能量片段选窗（与 RMS/HPCP/BPM 片段策略一致）
  let segments = select_feature_segments(&mono, TARGET_SAMPLE_RATE);
  let starts = build_window_starts_for_segments(mono.len(), window_len, hop_len, max_windows, &segments);

  // 分 batch 推理，RMS 加权平均
  let mut acc = vec![0f32; rt.embedding_dim];
  let mut weight_sum = 0f32;

  let batch_size = DEFAULT_BATCH.max(1);
  let frames = frame_count_1s();
  let zero_spec = vec![0f32; frames * N_MELS];
  for chunk in starts.chunks(batch_size) {
    let mut specs: Vec<Vec<f32>> = Vec::with_capacity(batch_size);
    let mut weights: Vec<f32> = Vec::with_capacity(batch_size);

    for &start in chunk {
      let segment = slice_reflect(&mono, start, window_len);
      let w = rms(&segment);
      weights.push(w);
      specs.push(compute_log_mel_spectrogram(&segment, &rt.window_fn, &rt.fft, &rt.mel_filters));
    }

    // 固定 batch=DEFAULT_BATCH：不足部分补 0，权重=0（不影响聚合）
    while specs.len() < batch_size {
      specs.push(zero_spec.clone());
      weights.push(0.0);
    }

    // 若本 batch 全部为静音，跳过推理
    if weights.iter().all(|w| *w <= 0.0) {
      continue;
    }

    let input = pack_batch_input(&rt.layout, &specs, frames, N_MELS)?;
    let outputs = rt
      .plan
      .run(tvec![input.into()])
      .map_err(|e| format!("openl3 推理失败: {}", e))?;
    let out = outputs
      .get(0)
      .ok_or_else(|| "openl3 输出为空".to_string())?;
    let embeddings = extract_batch_embeddings(out, batch_size, rt.embedding_dim)?;

    for (i, emb) in embeddings.into_iter().enumerate() {
      let w = weights.get(i).copied().unwrap_or(0.0);
      if w <= 0.0 {
        continue;
      }
      for j in 0..rt.embedding_dim {
        acc[j] += emb[j] * w;
      }
      weight_sum += w;
    }
  }

  if weight_sum <= 0.0 {
    return Err("静音或无法提取有效窗口".to_string());
  }
  for v in &mut acc {
    *v /= weight_sum;
  }
  Ok(acc)
}

fn get_runtime(model_path: &str) -> Result<Arc<OpenL3Runtime>, String> {
  let cell = OPENL3_RUNTIME.get_or_init(|| Mutex::new(None));
  let mut guard = cell.lock().map_err(|_| "openl3 runtime 锁失败".to_string())?;
  if let Some((p, rt)) = guard.as_ref() {
    if p == model_path {
      return Ok(rt.clone());
    }
  }
  let rt = Arc::new(load_runtime(model_path)?);
  *guard = Some((model_path.to_string(), rt.clone()));
  Ok(rt)
}

fn load_runtime(model_path: &str) -> Result<OpenL3Runtime, String> {
  let model_path_buf = Path::new(model_path);
  if !model_path_buf.exists() {
    return Err("runtime_unavailable: OpenL3 模型文件不存在".to_string());
  }

  let mut model = tract_onnx::onnx()
    .model_for_path(model_path_buf)
    .map_err(|e| format!("读取 OpenL3 ONNX 失败: {}", e))?;

  let input_fact = model
    .input_fact(0)
    .map_err(|e| format!("读取 OpenL3 输入失败: {}", e))?
    .clone();
  let layout = infer_input_layout(&input_fact)?;

  // 固定 batch=DEFAULT_BATCH：TypedRunnableModel 运行时不支持每次 run 改变 batch（否则会出现 1 != 16 的符号冲突）。
  // 推理时对不足 batch 的窗口做 0 填充，RMS 权重为 0，不影响聚合结果。
  let fixed_batch = DEFAULT_BATCH.max(1);

  // 适配：若模型需要固定帧数，主动固定为 199 帧（1s@48k）
  let frames = frame_count_1s();
  let shape = layout.build_shape(fixed_batch, frames, N_MELS);
  model = model
    .with_input_fact(0, InferenceFact::dt_shape(f32::datum_type(), shape))
    .map_err(|e| format!("设置 OpenL3 输入 shape 失败: {}", e))?;

  let plan = model
    .into_optimized()
    .map_err(|e| format!("OpenL3 优化失败: {}", e))?
    .into_runnable()
    .map_err(|e| format!("OpenL3 runnable 失败: {}", e))?;

  // 通过一次 dummy 推理确定 embedding dim
  let dummy_spec = vec![0f32; frames * N_MELS];
  let dummy_specs = vec![dummy_spec; fixed_batch];
  let dummy_input = pack_batch_input(&layout, &dummy_specs, frames, N_MELS)?;
  let outputs = plan
    .run(tvec![dummy_input.into()])
    .map_err(|e| format!("OpenL3 dummy 推理失败: {}", e))?;
  let out = outputs
    .get(0)
    .ok_or_else(|| "OpenL3 dummy 输出为空".to_string())?;
  let embedding_dim = infer_embedding_dim(out)?;

  let mel_filters = build_mel_filter_bank(TARGET_SAMPLE_RATE, N_FFT, N_MELS);
  let window_fn = build_hann_window(N_FFT);
  let mut planner = FftPlanner::<f32>::new();
  let fft = planner.plan_fft_forward(N_FFT);

  Ok(OpenL3Runtime {
    plan,
    layout,
    embedding_dim,
    mel_filters,
    window_fn,
    fft,
  })
}

fn infer_input_layout(fact: &InferenceFact) -> Result<InputLayout, String> {
  let Some(shape) = fact.shape.concretize() else {
    // 若全动态，按常见 NHWC 推断
    return Ok(InputLayout {
      rank: 4,
      batch_axis: 0,
      frames_axis: 1,
      mel_axis: 2,
      channel_axis: Some(3),
    });
  };
  let shape: Vec<usize> = shape
    .iter()
    .map(|d| d.as_i64().unwrap_or(0).max(0) as usize)
    .collect();
  let rank = shape.len();
  if rank == 4 {
    // 找出 256 / 199 / 1 的轴
    let mut mel_axis = None;
    let mut frames_axis = None;
    let mut ones: Vec<usize> = Vec::new();
    for (i, d) in shape.iter().enumerate() {
      if *d == N_MELS {
        mel_axis = Some(i);
      } else if *d == frame_count_1s() {
        frames_axis = Some(i);
      } else if *d == 1 {
        ones.push(i);
      }
    }
    let mel_axis = mel_axis.unwrap_or(2);
    let frames_axis = frames_axis.unwrap_or(1);
    let channel_axis = ones.into_iter().find(|i| *i != 0).or(Some(3));
    Ok(InputLayout {
      rank,
      batch_axis: 0,
      frames_axis,
      mel_axis,
      channel_axis,
    })
  } else if rank == 3 {
    // 常见：N x T x F 或 N x F x T
    let mut mel_axis = None;
    for (i, d) in shape.iter().enumerate() {
      if *d == N_MELS {
        mel_axis = Some(i);
      }
    }
    let mel_axis = mel_axis.unwrap_or(2);
    let frames_axis = if mel_axis == 1 { 2 } else { 1 };
    Ok(InputLayout {
      rank,
      batch_axis: 0,
      frames_axis,
      mel_axis,
      channel_axis: None,
    })
  } else {
    Err(format!("不支持的 OpenL3 输入 rank: {}", rank))
  }
}

impl InputLayout {
  fn build_shape(&self, batch: usize, frames: usize, mel: usize) -> TVec<TDim> {
    let mut dims: TVec<TDim> = tvec![1.into(); self.rank];
    dims[self.batch_axis] = (batch as i64).into();
    dims[self.frames_axis] = (frames as i64).into();
    dims[self.mel_axis] = (mel as i64).into();
    if let Some(ch) = self.channel_axis {
      dims[ch] = 1.into();
    }
    dims
  }
}

fn pack_batch_input(
  layout: &InputLayout,
  specs: &[Vec<f32>],
  frames: usize,
  mel: usize,
) -> Result<Tensor, String> {
  let batch = specs.len();
  if batch == 0 {
    return Err("batch 为空".to_string());
  }
  for s in specs {
    if s.len() != frames * mel {
      return Err("spectrogram 尺寸不匹配".to_string());
    }
  }

  let mut dims: Vec<usize> = vec![1; layout.rank];
  dims[layout.batch_axis] = batch;
  dims[layout.frames_axis] = frames;
  dims[layout.mel_axis] = mel;
  if let Some(ch) = layout.channel_axis {
    dims[ch] = 1;
  }

  let total: usize = dims.iter().product();
  let mut data = vec![0f32; total];

  let strides = compute_strides(&dims);
  for b in 0..batch {
    let spec = &specs[b];
    for t in 0..frames {
      for m in 0..mel {
        let val = spec[t * mel + m];
        let idx = b * strides[layout.batch_axis] + t * strides[layout.frames_axis] + m * strides[layout.mel_axis];
        data[idx] = val;
      }
    }
  }

  let shape: TVec<usize> = dims.into_iter().collect();
  Tensor::from_shape(&*shape, &data).map_err(|e| format!("构造输入 Tensor 失败: {}", e))
}

fn compute_strides(dims: &[usize]) -> Vec<usize> {
  let mut strides = vec![0usize; dims.len()];
  let mut acc = 1usize;
  for i in (0..dims.len()).rev() {
    strides[i] = acc;
    acc = acc.saturating_mul(dims[i].max(1));
  }
  strides
}

fn infer_embedding_dim(output: &Tensor) -> Result<usize, String> {
  let view = output
    .to_array_view::<f32>()
    .map_err(|e| format!("读取 OpenL3 输出失败: {}", e))?;
  let shape = view.shape();
  if shape.len() == 2 {
    // 常见输出：batch x dim；也可能是 dim x batch
    if shape[0] == 1 {
      return Ok(shape[1]);
    }
    if shape[1] == 1 {
      return Ok(shape[0]);
    }
    return Ok(shape[0].max(shape[1]));
  }
  if shape.len() == 1 {
    return Ok(shape[0]);
  }
  let n = view.len();
  if n > 0 {
    return Ok(n);
  }
  Err("无法推断 embedding dim".to_string())
}

fn extract_batch_embeddings(
  output: &Tensor,
  batch: usize,
  embedding_dim: usize,
) -> Result<Vec<Vec<f32>>, String> {
  let view = output
    .to_array_view::<f32>()
    .map_err(|e| format!("读取 OpenL3 输出失败: {}", e))?;
  let shape = view.shape().to_vec();
  if shape.len() == 2 {
    if shape[0] == batch && shape[1] == embedding_dim {
      let flat = view
        .as_slice()
        .ok_or_else(|| "OpenL3 输出不是连续内存".to_string())?;
      let mut out = Vec::with_capacity(batch);
      for b in 0..batch {
        out.push(flat[b * embedding_dim..(b + 1) * embedding_dim].to_vec());
      }
      return Ok(out);
    }
  }

  // 回退：按 batch 分块
  let flat = view.as_slice().ok_or_else(|| "OpenL3 输出不是连续内存".to_string())?;
  if flat.len() == batch * embedding_dim {
    let mut out = Vec::with_capacity(batch);
    for b in 0..batch {
      out.push(flat[b * embedding_dim..(b + 1) * embedding_dim].to_vec());
    }
    return Ok(out);
  }
  Err(format!(
    "OpenL3 输出 shape 不支持: {:?}, batch={}, dim={}",
    shape, batch, embedding_dim
  ))
}

fn decode_mono_limited(file_path: &str, max_seconds: f64) -> Result<(Vec<f32>, u32), String> {
  let res = crate::decode_audio_file_limited_sync(file_path.to_string(), max_seconds);
  if let Some(err) = res.error {
    return Err(err);
  }
  let sr = res.sample_rate;
  let channels = res.channels.max(1) as usize;
  let bytes = res.pcm_data.to_vec();
  let samples: &[f32] = cast_slice(&bytes);
  if channels == 1 {
    return Ok((samples.to_vec(), sr));
  }
  let frames = samples.len() / channels;
  let mut mono = Vec::with_capacity(frames);
  for i in 0..frames {
    let mut sum = 0f32;
    let base = i * channels;
    for c in 0..channels {
      sum += samples[base + c];
    }
    mono.push(sum / channels as f32);
  }
  Ok((mono, sr))
}

fn resample_linear(input: &[f32], src_sr: u32, dst_sr: u32) -> Vec<f32> {
  if input.is_empty() || src_sr == 0 || dst_sr == 0 || src_sr == dst_sr {
    return input.to_vec();
  }
  let ratio = dst_sr as f64 / src_sr as f64;
  let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
  let mut out = Vec::with_capacity(out_len);
  for i in 0..out_len {
    let pos = (i as f64) / ratio;
    let idx = pos.floor() as isize;
    let frac = (pos - idx as f64) as f32;
    let a = sample_reflect(input, idx);
    let b = sample_reflect(input, idx + 1);
    out.push(a * (1.0 - frac) + b * frac);
  }
  out
}

fn sample_reflect(signal: &[f32], idx: isize) -> f32 {
  if signal.is_empty() {
    return 0.0;
  }
  let n = signal.len() as isize;
  let period = (n - 1).max(1) * 2;
  let mut i = idx;
  if i < 0 {
    i = -i;
  }
  let mut m = i % period;
  if m >= n {
    m = period - m;
  }
  signal[m as usize]
}

fn build_window_starts(len: usize, hop: usize, max_windows: usize, start_at: usize) -> Vec<usize> {
  if len == 0 {
    return Vec::new();
  }
  let mut starts: Vec<usize> = Vec::new();
  let mut s = if start_at < len { start_at } else { 0usize };
  while s < len {
    starts.push(s);
    s = s.saturating_add(hop.max(1));
  }
  if starts.len() <= max_windows {
    return starts;
  }

  // 均匀抽样：确保覆盖从 start_at 到尾部的不同片段
  if max_windows <= 1 {
    return vec![starts[starts.len() / 2]];
  }
  let n = starts.len();
  let max_index = (n - 1) as u128;
  let denom = (max_windows - 1) as u128;
  let mut out: Vec<usize> = Vec::with_capacity(max_windows);
  for i in 0..max_windows {
    let idx = ((i as u128) * max_index / denom) as usize;
    out.push(starts[idx.min(n - 1)]);
  }
  out
}

fn build_window_starts_for_segments(
  len: usize,
  window_len: usize,
  hop: usize,
  max_windows: usize,
  segments: &[FeatureSegment],
) -> Vec<usize> {
  if len == 0 {
    return Vec::new();
  }
  if segments.is_empty() {
    return build_window_starts(len, hop, max_windows, 0);
  }

  let mut starts: Vec<usize> = Vec::new();
  for seg in segments {
    let seg_start = seg.start.min(len);
    let seg_end = seg.end.min(len);
    if seg_end <= seg_start {
      continue;
    }
    let last = if seg_end > window_len {
      seg_end.saturating_sub(window_len)
    } else {
      seg_start
    };
    let mut s = seg_start;
    while s <= last {
      starts.push(s);
      s = s.saturating_add(hop.max(1));
    }
  }

  if starts.is_empty() {
    return build_window_starts(len, hop, max_windows, 0);
  }

  starts.sort_unstable();
  starts.dedup();
  if starts.len() <= max_windows {
    return starts;
  }

  if max_windows <= 1 {
    return vec![starts[starts.len() / 2]];
  }
  let n = starts.len();
  let max_index = (n - 1) as u128;
  let denom = (max_windows - 1) as u128;
  let mut out: Vec<usize> = Vec::with_capacity(max_windows);
  for i in 0..max_windows {
    let idx = ((i as u128) * max_index / denom) as usize;
    out.push(starts[idx.min(n - 1)]);
  }
  out
}

fn slice_reflect(signal: &[f32], start: usize, len: usize) -> Vec<f32> {
  let mut out = Vec::with_capacity(len);
  for i in 0..len {
    out.push(sample_reflect(signal, (start + i) as isize));
  }
  out
}

fn select_feature_segments(signal: &[f32], sample_rate: u32) -> Vec<FeatureSegment> {
  if signal.is_empty() || sample_rate == 0 {
    return Vec::new();
  }

  let segment_frames =
    (FEATURE_SEGMENT_SECONDS * sample_rate as f32).round().max(1.0) as usize;
  if signal.len() <= segment_frames {
    return vec![FeatureSegment {
      start: 0,
      end: signal.len(),
      rms: rms(signal),
    }];
  }

  let hop_frames =
    (FEATURE_SEGMENT_HOP_SECONDS * sample_rate as f32).round().max(1.0) as usize;
  let edge_guard_frames =
    (FEATURE_SEGMENT_EDGE_GUARD_SECONDS * sample_rate as f32).round().max(0.0) as usize;
  let last_start = signal.len().saturating_sub(segment_frames);

  let mut candidates: Vec<FeatureSegment> = Vec::new();
  let mut start = 0usize;
  while start <= last_start {
    if edge_guard_frames > 0 {
      let max_start = last_start.saturating_sub(edge_guard_frames);
      if start < edge_guard_frames || start > max_start {
        start = start.saturating_add(hop_frames);
        continue;
      }
    }
    let end = start + segment_frames;
    let rms_value = rms(&signal[start..end]);
    candidates.push(FeatureSegment {
      start,
      end,
      rms: rms_value,
    });
    start = start.saturating_add(hop_frames);
  }

  if candidates.is_empty() {
    return vec![FeatureSegment {
      start: 0,
      end: signal.len(),
      rms: rms(signal),
    }];
  }

  candidates.sort_by(|a, b| {
    b.rms
      .partial_cmp(&a.rms)
      .unwrap_or(std::cmp::Ordering::Equal)
  });

  let min_gap_frames = (segment_frames as f32 * FEATURE_SEGMENT_MIN_GAP_RATIO)
    .round()
    .max(1.0) as usize;
  let mut selected: Vec<FeatureSegment> = Vec::new();

  for candidate in candidates {
    if selected.len() >= FEATURE_SEGMENT_COUNT {
      break;
    }
    let separated = selected.iter().all(|seg| {
      let diff = candidate.start as i64 - seg.start as i64;
      diff.abs() as usize >= min_gap_frames
    });
    if !separated {
      continue;
    }
    selected.push(candidate);
  }

  if selected.is_empty() {
    return vec![FeatureSegment {
      start: 0,
      end: signal.len(),
      rms: rms(signal),
    }];
  }

  selected.sort_by(|a, b| a.start.cmp(&b.start));
  selected
}

fn rms(x: &[f32]) -> f32 {
  if x.is_empty() {
    return 0.0;
  }
  let mut sum = 0f64;
  for v in x {
    sum += (*v as f64) * (*v as f64);
  }
  let mean = sum / (x.len() as f64);
  (mean.sqrt() as f32).max(0.0)
}

fn frame_count_1s() -> usize {
  let len = (TARGET_SAMPLE_RATE as f32 * WINDOW_SECONDS).round().max(1.0) as usize;
  let pad = N_FFT / 2;
  (len + 2 * pad - N_FFT) / HOP_LENGTH + 1
}

fn build_hann_window(n: usize) -> Vec<f32> {
  if n == 0 {
    return Vec::new();
  }
  let mut w = Vec::with_capacity(n);
  for i in 0..n {
    let x = (2.0 * std::f32::consts::PI * i as f32) / (n as f32);
    w.push(0.5 - 0.5 * x.cos());
  }
  w
}

fn build_mel_filter_bank(sr: u32, n_fft: usize, n_mels: usize) -> Vec<Vec<(usize, f32)>> {
  let f_min = 0.0;
  let f_max = (sr as f32) / 2.0;
  let mel_min = hz_to_mel(f_min);
  let mel_max = hz_to_mel(f_max);

  let mut mel_points: Vec<f32> = Vec::with_capacity(n_mels + 2);
  for i in 0..(n_mels + 2) {
    let m = mel_min + (mel_max - mel_min) * (i as f32) / ((n_mels + 1) as f32);
    mel_points.push(mel_to_hz(m));
  }

  let n_freqs = n_fft / 2 + 1;
  let mut bins: Vec<usize> = mel_points
    .iter()
    .map(|hz| ((n_fft + 1) as f32 * hz / (sr as f32)).floor() as usize)
    .map(|b| b.min(n_freqs.saturating_sub(1)))
    .collect();

  // 修正：单调递增
  for i in 1..bins.len() {
    if bins[i] < bins[i - 1] {
      bins[i] = bins[i - 1];
    }
  }

  let mut filters: Vec<Vec<(usize, f32)>> = Vec::with_capacity(n_mels);
  for m in 0..n_mels {
    let left = bins[m];
    let center = bins[m + 1];
    let right = bins[m + 2];

    let mut f: Vec<(usize, f32)> = Vec::new();
    if left == center && center == right {
      if center < n_freqs {
        f.push((center, 1.0));
      }
      filters.push(f);
      continue;
    }

    if left < center {
      for k in left..=center {
        let w = (k as f32 - left as f32) / ((center - left) as f32);
        if w > 0.0 {
          f.push((k, w));
        }
      }
    }
    if center < right {
      for k in center..=right {
        let w = (right as f32 - k as f32) / ((right - center) as f32);
        if w > 0.0 {
          f.push((k, w));
        }
      }
    }
    filters.push(f);
  }
  filters
}

fn hz_to_mel(hz: f32) -> f32 {
  2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
  700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

fn reflect_pad(input: &[f32], pad: usize) -> Vec<f32> {
  if pad == 0 {
    return input.to_vec();
  }
  let n = input.len();
  if n == 0 {
    return vec![0.0; pad * 2];
  }
  let mut out = Vec::with_capacity(n + pad * 2);

  // 左侧 reflect（不重复边界）
  for i in 0..pad {
    let src = (pad - i).min(n - 1);
    out.push(input[src]);
  }
  out.extend_from_slice(input);
  // 右侧 reflect（不重复边界）
  for i in 0..pad {
    let src = (n.saturating_sub(2)).saturating_sub(i).min(n - 1);
    out.push(input[src]);
  }
  out
}

fn compute_log_mel_spectrogram(
  segment: &[f32],
  window_fn: &[f32],
  fft: &Arc<dyn Fft<f32>>,
  mel_filters: &[Vec<(usize, f32)>],
) -> Vec<f32> {
  let pad = N_FFT / 2;
  let padded = reflect_pad(segment, pad);
  let frames = (segment.len() + 2 * pad - N_FFT) / HOP_LENGTH + 1;
  let n_bins = N_FFT / 2 + 1;
  let mut out = vec![0f32; frames * N_MELS];

  let mut fft_buf: Vec<Complex<f32>> = vec![Complex { re: 0.0, im: 0.0 }; N_FFT];
  let mut power: Vec<f32> = vec![0f32; n_bins];

  for t in 0..frames {
    let start = t * HOP_LENGTH;
    for i in 0..N_FFT {
      let v = padded[start + i] * window_fn[i];
      fft_buf[i] = Complex { re: v, im: 0.0 };
    }
    fft.process(&mut fft_buf);
    for k in 0..n_bins {
      let c = fft_buf[k];
      power[k] = c.re * c.re + c.im * c.im;
    }

    for m in 0..N_MELS {
      let mut sum = 0f32;
      for (k, w) in &mel_filters[m] {
        sum += power[*k] * (*w);
      }
      out[t * N_MELS + m] = (sum.max(0.0) + 1e-10).ln();
    }
  }
  out
}
