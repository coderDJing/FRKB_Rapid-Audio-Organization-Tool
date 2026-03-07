#!/usr/bin/env python3
import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from demucs.pretrained import get_model

PROGRESS_PREFIX = 'FRKB_ONNX_PROGRESS='
RESULT_PREFIX = 'FRKB_ONNX_RESULT='
DEFAULT_SOURCE_ORDER_4STEMS = ['drums', 'bass', 'other', 'vocals']
DEFAULT_SOURCE_ORDER_6STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
SOURCE_NAME_ALIASES = {
  'vocal': 'vocals',
  'vox': 'vocals',
  'drum': 'drums',
  'instrumental': 'other',
  'accompaniment': 'other'
}


def emit_progress(payload: dict) -> None:
  print(f'{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False)}', flush=True)


def emit_result(payload: dict) -> None:
  print(f'{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}', flush=True)


def normalize_waveform_channels(waveform: torch.Tensor) -> torch.Tensor:
  if waveform.dim() == 1:
    waveform = waveform.unsqueeze(0)
  if waveform.dim() != 2:
    raise RuntimeError(f'Invalid waveform rank: {waveform.shape}')
  channels, _ = waveform.shape
  if channels == 1:
    waveform = waveform.repeat(2, 1)
  elif channels > 2:
    waveform = waveform[:2, :]
  return waveform


def decode_audio_with_ffmpeg(input_path: Path, ffmpeg_path: Path, sample_rate: int) -> torch.Tensor:
  cmd = [
    str(ffmpeg_path),
    '-v',
    'error',
    '-i',
    str(input_path),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ac',
    '2',
    '-ar',
    str(sample_rate),
    '-'
  ]
  proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
  if proc.returncode != 0:
    raise RuntimeError(f'ffmpeg decode failed: {proc.stderr.decode("utf-8", errors="ignore").strip()}')
  audio = np.frombuffer(proc.stdout, dtype='<f4')
  if audio.size <= 0:
    raise RuntimeError('ffmpeg decode produced empty PCM output')
  frame_count = audio.size // 2
  if frame_count <= 0:
    raise RuntimeError('ffmpeg decode produced invalid channel layout')
  audio = audio[:frame_count * 2].reshape(frame_count, 2).T
  return torch.from_numpy(np.ascontiguousarray(audio))


def save_audio_with_ffmpeg(output_path: Path, ffmpeg_path: Path, waveform: torch.Tensor, sample_rate: int) -> None:
  pcm = waveform.detach().cpu().to(torch.float32).numpy()
  if pcm.ndim != 2:
    raise RuntimeError(f'Invalid waveform shape for save: {pcm.shape}')
  channels, _ = pcm.shape
  if channels != 2:
    raise RuntimeError(f'Only stereo output is supported, got channels={channels}')
  pcm_interleaved = np.ascontiguousarray(pcm.T, dtype=np.float32)
  cmd = [
    str(ffmpeg_path),
    '-v',
    'error',
    '-y',
    '-f',
    'f32le',
    '-ac',
    '2',
    '-ar',
    str(sample_rate),
    '-i',
    '-',
    '-c:a',
    'pcm_f32le',
    str(output_path)
  ]
  proc = subprocess.run(
    cmd,
    input=pcm_interleaved.tobytes(),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False
  )
  if proc.returncode != 0:
    raise RuntimeError(f'ffmpeg save failed: {proc.stderr.decode("utf-8", errors="ignore").strip()}')


def resolve_input_binding(session: ort.InferenceSession):
  input_items = session.get_inputs()
  if len(input_items) < 2:
    raise RuntimeError('ONNX model input count is less than 2')
  mix_input = None
  spec_input = None
  for item in input_items:
    shape = list(item.shape or [])
    rank = len(shape)
    second_dim = shape[1] if rank > 1 else None
    if rank == 3 and str(second_dim) in ('2', '2.0'):
      mix_input = item
    elif rank == 4 and str(second_dim) in ('4', '4.0'):
      spec_input = item
  if mix_input is None:
    mix_input = input_items[0]
  if spec_input is None:
    spec_input = input_items[1]
  return mix_input, spec_input


def resolve_chunk_samples(mix_input, fallback: int) -> int:
  shape = list(mix_input.shape or [])
  if len(shape) >= 3:
    maybe_len = shape[-1]
    if isinstance(maybe_len, int) and maybe_len > 0:
      return int(maybe_len)
    if isinstance(maybe_len, str) and maybe_len.isdigit():
      parsed = int(maybe_len)
      if parsed > 0:
        return parsed
  return max(1, int(fallback))


def resolve_stem_wave_output(outputs):
  for output in outputs:
    array = np.asarray(output)
    if array.ndim != 4:
      continue
    # [1, stems, channels, samples]
    if array.shape[1] >= 4 and array.shape[2] == 2:
      return array[0]
    # [1, channels, stems, samples]
    if array.shape[1] == 2 and array.shape[2] >= 4:
      return np.transpose(array[0], (1, 0, 2))
    # [1, stems, samples, channels]
    if array.shape[1] >= 4 and array.shape[3] == 2:
      return np.transpose(array[0], (0, 2, 1))
  raise RuntimeError('Unable to locate waveform output in ONNX inference result')


def normalize_source_name(value: str) -> str:
  lowered = str(value or '').strip().lower()
  cleaned = lowered.replace(' ', '').replace('-', '').replace('_', '')
  return SOURCE_NAME_ALIASES.get(cleaned, cleaned)


def resolve_source_order(source_count: int, raw_order: str) -> list[str]:
  parsed = [normalize_source_name(item) for item in str(raw_order or '').split(',')]
  parsed = [item for item in parsed if item]
  if len(parsed) == source_count:
    return parsed
  if source_count == 6:
    return list(DEFAULT_SOURCE_ORDER_6STEMS)
  if source_count == 4:
    return list(DEFAULT_SOURCE_ORDER_4STEMS)
  return [f'stem{index + 1}' for index in range(source_count)]


def find_source_index(source_order: list[str], candidates: list[str]) -> int | None:
  for candidate in candidates:
    normalized = normalize_source_name(candidate)
    if normalized in source_order:
      return source_order.index(normalized)
  return None


def pick_stem(stems: np.ndarray, index: int | None) -> np.ndarray:
  if index is None or index < 0 or index >= stems.shape[0]:
    return np.zeros((2, stems.shape[-1]), dtype=np.float32)
  return np.asarray(stems[index], dtype=np.float32)


def build_chunk_starts(total_samples: int, chunk_samples: int, stride: int):
  if total_samples <= chunk_samples:
    return [0]
  starts = list(range(0, total_samples, stride))
  last_start = max(0, total_samples - chunk_samples)
  if not starts or starts[-1] != last_start:
    starts.append(last_start)
  return sorted(set(starts))


def normalize_stem_wave_shape(stem_wave: np.ndarray, chunk_samples: int) -> np.ndarray:
  normalized = np.asarray(stem_wave, dtype=np.float32)
  normalized = normalized[:4, :, :]
  if normalized.shape[-1] < chunk_samples:
    padded = np.zeros((4, 2, chunk_samples), dtype=np.float32)
    padded[:, :, :normalized.shape[-1]] = normalized
    normalized = padded
  if normalized.shape[-1] > chunk_samples:
    normalized = normalized[:, :, :chunk_samples]
  return normalized


def run_infer_chunk(
  *,
  session: ort.InferenceSession,
  helper,
  mix_input,
  spec_input,
  waveform_np: np.ndarray,
  start: int,
  total_samples: int,
  chunk_samples: int
):
  end = min(start + chunk_samples, total_samples)
  valid_length = max(0, end - start)
  if valid_length <= 0:
    return None

  mix_chunk = np.zeros((2, chunk_samples), dtype=np.float32)
  mix_chunk[:, :valid_length] = waveform_np[:, start:end]
  mix_tensor = torch.from_numpy(mix_chunk).unsqueeze(0)
  with torch.no_grad():
    spec_tensor = helper._magnitude(helper._spec(mix_tensor))
  feeds = {
    mix_input.name: mix_tensor.numpy().astype(np.float32, copy=False),
    spec_input.name: spec_tensor.numpy().astype(np.float32, copy=False)
  }
  output_list = session.run(None, feeds)
  stem_wave = normalize_stem_wave_shape(resolve_stem_wave_output(output_list), chunk_samples)
  return stem_wave, valid_length, mix_chunk


def compute_chunk_residual_score(
  *,
  mix_chunk: np.ndarray,
  stem_wave: np.ndarray,
  valid_length: int
) -> float:
  if valid_length <= 0:
    return 0.0
  mix_valid = np.asarray(mix_chunk[:, :valid_length], dtype=np.float32)
  stem_valid = np.asarray(stem_wave[:, :, :valid_length], dtype=np.float32)
  reconstructed = np.sum(stem_valid, axis=0, dtype=np.float32)
  residual = mix_valid - reconstructed
  residual_rms = float(np.sqrt(np.mean(residual * residual)))
  signal_rms = float(np.sqrt(np.mean(mix_valid * mix_valid)))
  if not np.isfinite(residual_rms) or not np.isfinite(signal_rms):
    return 0.0
  return residual_rms / max(1e-6, signal_rms)


def select_refine_starts(
  *,
  chunk_scores: list[tuple[int, float]],
  base_starts: list[int],
  chunk_samples: int,
  total_samples: int,
  topk_ratio: float,
  max_chunks: int,
  offset_ratio: float,
  min_score: float
) -> list[int]:
  if not chunk_scores:
    return []
  if topk_ratio <= 0 or max_chunks <= 0:
    return []

  target_by_ratio = int(math.ceil(len(base_starts) * topk_ratio))
  target = min(max_chunks, max(0, target_by_ratio))
  if target <= 0:
    return []

  last_start = max(0, total_samples - chunk_samples)
  offset_samples = int(round(chunk_samples * max(0.0, min(1.0, offset_ratio))))
  base_start_set = set(base_starts)
  selected: list[int] = []
  selected_set = set()

  sorted_scores = sorted(chunk_scores, key=lambda item: item[1], reverse=True)
  for start, score in sorted_scores:
    if score < min_score:
      break
    refined_start = min(last_start, max(0, start + offset_samples))
    if refined_start in base_start_set or refined_start in selected_set:
      continue
    selected.append(refined_start)
    selected_set.add(refined_start)
    if len(selected) >= target:
      break

  return sorted(selected)


def parse_args():
  parser = argparse.ArgumentParser(description='FRKB ONNX fast stem separation')
  parser.add_argument('--input', required=True)
  parser.add_argument('--output-dir', required=True)
  parser.add_argument('--onnx-model', required=True)
  parser.add_argument('--demucs-model-repo', required=True)
  parser.add_argument('--ffmpeg-path', required=True)
  parser.add_argument('--provider', choices=['directml', 'cpu'], default='cpu')
  parser.add_argument('--overlap', type=float, default=0.2)
  parser.add_argument('--helper-model', default='htdemucs')
  parser.add_argument('--source-order', default='')
  parser.add_argument('--torch-threads', type=int, default=1)
  parser.add_argument('--refine-topk-ratio', type=float, default=0.0)
  parser.add_argument('--refine-max-chunks', type=int, default=0)
  parser.add_argument('--refine-offset-ratio', type=float, default=0.5)
  parser.add_argument('--refine-min-score', type=float, default=0.0)
  return parser.parse_args()


def main():
  args = parse_args()
  input_path = Path(args.input).resolve()
  output_dir = Path(args.output_dir).resolve()
  onnx_model_path = Path(args.onnx_model).resolve()
  demucs_model_repo = Path(args.demucs_model_repo).resolve()
  ffmpeg_path = Path(args.ffmpeg_path).resolve()

  if not input_path.exists():
    raise RuntimeError(f'Input file not found: {input_path}')
  if not onnx_model_path.exists():
    raise RuntimeError(f'ONNX model not found: {onnx_model_path}')
  if not demucs_model_repo.exists():
    raise RuntimeError(f'Demucs model repo not found: {demucs_model_repo}')
  if not ffmpeg_path.exists():
    raise RuntimeError(f'ffmpeg not found: {ffmpeg_path}')

  output_dir.mkdir(parents=True, exist_ok=True)

  torch.set_grad_enabled(False)
  torch_threads = max(1, int(args.torch_threads))
  torch.set_num_threads(torch_threads)
  torch.set_num_interop_threads(max(1, torch_threads))

  helper = get_model(name=args.helper_model, repo=demucs_model_repo)
  if hasattr(helper, 'models') and helper.models:
    helper = helper.models[0]
  helper.eval()
  helper = helper.cpu()

  sample_rate = int(getattr(helper, 'samplerate', 44100) or 44100)
  fallback_chunk_samples = int(
    round(float(getattr(helper, 'segment', 7.8) or 7.8) * sample_rate)
  )

  waveform = decode_audio_with_ffmpeg(input_path, ffmpeg_path, sample_rate)
  waveform = normalize_waveform_channels(waveform).to(torch.float32).contiguous()
  waveform_np = waveform.detach().cpu().numpy().astype(np.float32, copy=False)
  total_samples = int(waveform_np.shape[-1])
  if total_samples <= 0:
    raise RuntimeError('Input audio has zero samples')

  requested_provider = 'DmlExecutionProvider' if args.provider == 'directml' else 'CPUExecutionProvider'
  provider_chain = [requested_provider] if requested_provider != 'CPUExecutionProvider' else []
  provider_chain.append('CPUExecutionProvider')
  session_options = ort.SessionOptions()
  if args.provider == 'directml':
    # Intel/AMD 部分驱动在 DML 图融合阶段会崩，fast 模式优先稳定可用。
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    session_options.enable_mem_pattern = False
  session = ort.InferenceSession(
    str(onnx_model_path),
    sess_options=session_options,
    providers=provider_chain
  )
  active_provider = session.get_providers()[0] if session.get_providers() else 'UnknownExecutionProvider'
  if args.provider == 'directml' and active_provider != 'DmlExecutionProvider':
    raise RuntimeError(
      f'DirectML provider unavailable, active provider: {active_provider}'
    )

  mix_input, spec_input = resolve_input_binding(session)
  chunk_samples = resolve_chunk_samples(mix_input, fallback_chunk_samples)
  overlap = min(0.95, max(0.0, float(args.overlap)))
  refine_topk_ratio = min(1.0, max(0.0, float(args.refine_topk_ratio)))
  refine_max_chunks = max(0, int(args.refine_max_chunks))
  refine_offset_ratio = min(1.0, max(0.0, float(args.refine_offset_ratio)))
  refine_min_score = max(0.0, float(args.refine_min_score))
  stride = max(1, int(round(chunk_samples * (1.0 - overlap))))
  starts = build_chunk_starts(total_samples, chunk_samples, stride)
  full_length = max(total_samples, starts[-1] + chunk_samples)

  accumulator = np.zeros((4, 2, full_length), dtype=np.float32)
  weights = np.zeros((1, 1, full_length), dtype=np.float32)
  window = np.hanning(chunk_samples).astype(np.float32)
  if not np.isfinite(window).all() or float(window.max()) <= 0:
    window = np.ones((chunk_samples,), dtype=np.float32)
  window = np.maximum(window, 1e-3)
  window_3d = window.reshape(1, 1, chunk_samples)

  def accumulate_stem_chunk(*, start: int, valid_length: int, stem_wave: np.ndarray) -> None:
    slice_end = start + valid_length
    accumulator[:, :, start:slice_end] += stem_wave[:, :, :valid_length] * window_3d[:, :, :valid_length]
    weights[:, :, start:slice_end] += window_3d[:, :, :valid_length]

  chunk_scores: list[tuple[int, float]] = []
  emit_progress({
    'stage': 'start',
    'provider': active_provider,
    'totalChunks': len(starts),
    'chunkSamples': chunk_samples,
    'sampleRate': sample_rate,
    'percent': 0
  })

  for index, start in enumerate(starts):
    infer_output = run_infer_chunk(
      session=session,
      helper=helper,
      mix_input=mix_input,
      spec_input=spec_input,
      waveform_np=waveform_np,
      start=start,
      total_samples=total_samples,
      chunk_samples=chunk_samples
    )
    if infer_output is None:
      continue
    stem_wave, valid_length, mix_chunk = infer_output
    accumulate_stem_chunk(start=start, valid_length=valid_length, stem_wave=stem_wave)
    chunk_scores.append(
      (start, compute_chunk_residual_score(mix_chunk=mix_chunk, stem_wave=stem_wave, valid_length=valid_length))
    )

    percent = int(round(((index + 1) / max(1, len(starts))) * 88))
    emit_progress({
      'stage': 'infer',
      'provider': active_provider,
      'chunkIndex': index + 1,
      'totalChunks': len(starts),
      'percent': max(0, min(100, percent))
    })

  refine_starts = select_refine_starts(
    chunk_scores=chunk_scores,
    base_starts=starts,
    chunk_samples=chunk_samples,
    total_samples=total_samples,
    topk_ratio=refine_topk_ratio,
    max_chunks=refine_max_chunks,
    offset_ratio=refine_offset_ratio,
    min_score=refine_min_score
  )
  for index, start in enumerate(refine_starts):
    infer_output = run_infer_chunk(
      session=session,
      helper=helper,
      mix_input=mix_input,
      spec_input=spec_input,
      waveform_np=waveform_np,
      start=start,
      total_samples=total_samples,
      chunk_samples=chunk_samples
    )
    if infer_output is None:
      continue
    stem_wave, valid_length, _ = infer_output
    accumulate_stem_chunk(start=start, valid_length=valid_length, stem_wave=stem_wave)
    percent = int(round(88 + ((index + 1) / max(1, len(refine_starts))) * 10))
    emit_progress({
      'stage': 'refine',
      'provider': active_provider,
      'chunkIndex': index + 1,
      'totalChunks': len(refine_starts),
      'percent': max(88, min(98, percent))
    })

  weights = np.maximum(weights[:, :, :total_samples], 1e-6)
  stems = accumulator[:, :, :total_samples] / weights
  stems = np.nan_to_num(stems, nan=0.0, posinf=0.0, neginf=0.0)
  source_count = int(stems.shape[0])
  source_order = resolve_source_order(source_count, args.source_order)
  source_order = source_order[:source_count]

  vocals_index = find_source_index(source_order, ['vocals'])
  drums_index = find_source_index(source_order, ['drums'])
  bass_index = find_source_index(source_order, ['bass'])

  # 向后兼容：未知来源顺序时，沿用旧的 htdemucs 前四轨约定。
  if drums_index is None and source_count >= 1:
    drums_index = 0
  if bass_index is None and source_count >= 2:
    bass_index = 1
  if vocals_index is None and source_count >= 4:
    vocals_index = 3
  elif vocals_index is None and source_count >= 1:
    vocals_index = source_count - 1

  reserved_indices = {index for index in [vocals_index, drums_index, bass_index] if index is not None}
  inst_indices = [index for index in range(source_count) if index not in reserved_indices]

  drums_np = pick_stem(stems, drums_index)
  bass_np = pick_stem(stems, bass_index)
  vocals_np = pick_stem(stems, vocals_index)

  inst_np = np.zeros((2, total_samples), dtype=np.float32)
  if inst_indices:
    inst_np = np.sum(stems[inst_indices], axis=0, dtype=np.float32)

  # 重建约束：保证四轨全开时尽量贴回原混音，避免“全开也不像原曲”。
  mix_np = waveform_np[:, :total_samples]
  residual_np = mix_np - (vocals_np + inst_np + bass_np + drums_np)
  inst_np = inst_np + residual_np

  drums = torch.from_numpy(drums_np).to(torch.float32)
  bass = torch.from_numpy(bass_np).to(torch.float32)
  vocals = torch.from_numpy(vocals_np).to(torch.float32)
  inst = torch.from_numpy(inst_np).to(torch.float32)

  drums_path = output_dir / 'drums.wav'
  bass_path = output_dir / 'bass.wav'
  inst_path = output_dir / 'inst.wav'
  vocal_path = output_dir / 'vocal.wav'
  save_audio_with_ffmpeg(drums_path, ffmpeg_path, drums, sample_rate)
  save_audio_with_ffmpeg(bass_path, ffmpeg_path, bass, sample_rate)
  save_audio_with_ffmpeg(inst_path, ffmpeg_path, inst, sample_rate)
  save_audio_with_ffmpeg(vocal_path, ffmpeg_path, vocals, sample_rate)

  emit_progress({
    'stage': 'done',
    'provider': active_provider,
    'percent': 100
  })
  emit_result({
    'provider': active_provider,
    'vocalPath': str(vocal_path),
    'instPath': str(inst_path),
    'bassPath': str(bass_path),
    'drumsPath': str(drums_path)
  })


if __name__ == '__main__':
  main()
