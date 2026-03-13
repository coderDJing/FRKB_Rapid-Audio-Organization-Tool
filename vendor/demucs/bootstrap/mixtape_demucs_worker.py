import json
import sys
import traceback
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from mixtape_demucs_bootstrap import _maybe_import_directml, _patch_torch_load, _save_wav


STATE = {
    "signature": "",
    "device": "",
    "model_name": "",
    "model_repo_path": "",
    "model": None,
}


def _write_message(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _normalize_text(value, max_len=4000):
    text = str(value or "").strip()
    if not text:
      return ""
    return text if len(text) <= max_len else text[:max_len]


def _ensure_model(payload):
    import torch as th
    from demucs.apply import BagOfModels
    from demucs.pretrained import get_model

    model_name = str(payload["modelName"])
    model_repo_path = str(payload["modelRepoPath"])
    device = str(payload.get("device") or "xpu")
    signature = f"{device}::{model_name}::{model_repo_path}"
    if STATE["model"] is not None and STATE["signature"] == signature:
        return STATE["model"]

    model = get_model(name=model_name, repo=Path(model_repo_path))
    model.to(device)
    model.eval()
    if isinstance(model, BagOfModels):
        for sub_model in model.models:
            sub_model.to(device)
            sub_model.eval()
    STATE["signature"] = signature
    STATE["device"] = device
    STATE["model_name"] = model_name
    STATE["model_repo_path"] = model_repo_path
    STATE["model"] = model
    return model


def _resolve_max_allowed_segment(model):
    from demucs.apply import BagOfModels
    from demucs.htdemucs import HTDemucs

    max_allowed_segment = float("inf")
    if isinstance(model, HTDemucs):
        max_allowed_segment = float(model.segment)
    elif isinstance(model, BagOfModels):
        max_allowed_segment = model.max_allowed_segment
    return max_allowed_segment


def _run_warmup(payload):
    import torch as th
    from demucs.apply import apply_model

    model = _ensure_model(payload)
    device = str(payload.get("device") or "xpu")
    requested_segment = payload.get("segmentSec")
    max_allowed_segment = _resolve_max_allowed_segment(model)
    if requested_segment is not None:
        requested_segment = float(requested_segment)
        if requested_segment > max_allowed_segment:
            requested_segment = max_allowed_segment
    else:
        requested_segment = min(max_allowed_segment, 7.8)

    sample_rate = int(getattr(model, "samplerate", 44100))
    channels = int(getattr(model, "audio_channels", 2))
    warmup_length = max(1, int(sample_rate * float(requested_segment)))
    wav = th.randn((1, channels, warmup_length), dtype=th.float32) * 0.01
    ref = wav[0].mean(0)
    ref_std = ref.std()
    if not th.isfinite(ref_std) or float(ref_std) <= 1e-8:
        ref_std = th.tensor(1.0, dtype=wav.dtype)
    wav = wav - ref.mean()
    wav = wav / ref_std
    apply_model(
        model,
        wav,
        device=device,
        shifts=0,
        split=True,
        overlap=0.25,
        progress=False,
        num_workers=0,
        segment=float(requested_segment),
    )[0]


def _run_infer(payload):
    import torch as th

    from demucs.apply import apply_model
    from demucs.audio import convert_audio

    model = _ensure_model(payload)
    model_name = str(payload["modelName"])
    output_dir = Path(str(payload["outputDir"]))
    pcm_path = Path(str(payload["inputPcmPath"]))
    samplerate = int(payload["inputSampleRate"])
    channels = int(payload["inputChannels"])
    total_frames = int(payload["inputFrames"])
    device = str(payload["device"])
    shifts = int(payload.get("shifts", 1))
    overlap = float(payload.get("overlap", 0.25))
    split = bool(payload.get("split", True))
    segment_sec = payload.get("segmentSec")
    jobs = int(payload.get("jobs", 0))

    if not pcm_path.is_file():
        raise RuntimeError(f"PCM input file missing: {pcm_path}")
    if samplerate <= 0 or channels <= 0:
        raise RuntimeError(f"Invalid PCM metadata: samplerate={samplerate} channels={channels}")

    raw = np.fromfile(pcm_path, dtype=np.float32)
    expected_samples = max(0, total_frames * channels)
    if expected_samples and raw.size != expected_samples:
        raise RuntimeError(
            f"PCM sample count mismatch: expected {expected_samples} got {raw.size}"
        )
    if raw.size % channels != 0:
        raise RuntimeError("PCM sample count is not divisible by channels.")
    if raw.size == 0:
        raise RuntimeError("PCM input is empty.")

    wav = th.from_numpy(raw.reshape(-1, channels).transpose()).float()
    max_allowed_segment = _resolve_max_allowed_segment(model)
    if segment_sec is not None:
        segment_sec = float(segment_sec)
        if segment_sec > max_allowed_segment:
            raise RuntimeError(
                f"Cannot use segment {segment_sec} with model {model_name}, maximum is {max_allowed_segment}"
            )

    wav = convert_audio(wav, samplerate, model.samplerate, model.audio_channels)
    ref = wav.mean(0)
    ref_std = ref.std()
    if not th.isfinite(ref_std) or float(ref_std) <= 1e-8:
        ref_std = th.tensor(1.0, dtype=wav.dtype)
    wav = wav - ref.mean()
    wav = wav / ref_std

    sources = apply_model(
        model,
        wav[None],
        device=device,
        shifts=shifts,
        split=split,
        overlap=overlap,
        progress=split,
        num_workers=jobs,
        segment=segment_sec,
    )[0]
    sources = sources * ref_std
    sources = sources + ref.mean()

    target_dir = output_dir / model_name
    for source, name in zip(sources, model.sources):
        _save_wav(target_dir / f"{name}.wav", source, model.samplerate)


def _handle_request(message):
    request_type = str(message.get("type") or "").strip()
    request_id = str(message.get("requestId") or "").strip()
    if not request_type or not request_id:
        raise RuntimeError("Worker request missing type/requestId")

    if request_type == "warmup":
        payload = dict(message.get("payload") or {})
        _run_warmup(payload)
        _write_message(
            {
                "type": "ready",
                "requestId": request_id,
                "payload": {
                    "modelName": STATE["model_name"],
                    "device": STATE["device"],
                },
            }
        )
        return False

    if request_type == "infer":
        payload = dict(message.get("payload") or {})
        _run_infer(payload)
        _write_message(
            {
                "type": "result",
                "requestId": request_id,
                "payload": {
                    "modelName": STATE["model_name"],
                    "device": STATE["device"],
                },
            }
        )
        return False

    if request_type == "shutdown":
        _write_message({"type": "result", "requestId": request_id, "payload": {"shutdown": True}})
        return True

    raise RuntimeError(f"Unsupported worker request type: {request_type}")


def main():
    _patch_torch_load()
    _maybe_import_directml()
    for line in sys.stdin:
        normalized = _normalize_text(line, 100000)
        if not normalized:
            continue
        try:
            message = json.loads(normalized)
            should_stop = _handle_request(message)
            if should_stop:
                return
        except Exception as error:
            request_id = ""
            try:
                request_id = str(json.loads(normalized).get("requestId") or "").strip()
            except Exception:
                request_id = ""
            _write_message(
                {
                    "type": "error",
                    "requestId": request_id,
                    "code": "PERSISTENT_XPU_WORKER_REQUEST_FAILED",
                    "error": _normalize_text(f"{error}\n{traceback.format_exc()}", 6000),
                }
            )


if __name__ == "__main__":
    main()
