import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np


def _patch_torch_load():
    import torch

    original_load = torch.load

    def patched_load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return original_load(*args, **kwargs)

    torch.load = patched_load


def _patch_load_track():
    from demucs.audio import AudioFile
    import demucs.separate as separate

    def load_track(track, audio_channels, samplerate):
        try:
            return AudioFile(track).read(
                streams=0,
                samplerate=samplerate,
                channels=audio_channels,
            )
        except FileNotFoundError:
            print("Could not load file {}. FFmpeg is not installed.".format(track))
            sys.exit(1)
        except subprocess.CalledProcessError:
            print("Could not load file {}. FFmpeg could not read the file.".format(track))
            sys.exit(1)

    separate.load_track = load_track
    return separate


def _maybe_import_directml():
    try:
        import torch_directml  # noqa: F401
    except Exception:
        return


def _save_wav(path, wav_tensor, samplerate):
    wav = wav_tensor.detach().cpu().transpose(0, 1).contiguous().numpy()
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 1.0:
        wav = wav / max(1.01 * peak, 1.0)
    wav = np.clip(wav, -1.0, 1.0)
    pcm = (wav * (2**15 - 1)).astype(np.int16, copy=False)
    channels = pcm.shape[1] if pcm.ndim > 1 else 1
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(int(samplerate))
        writer.writeframes(pcm.tobytes())


def _run_cli_mode(argv):
    separate = _patch_load_track()
    sys.argv = argv
    separate.main(argv[1:])


def _run_waveform_mode(payload):
    import torch as th

    from demucs.apply import BagOfModels, apply_model
    from demucs.audio import convert_audio
    from demucs.htdemucs import HTDemucs
    from demucs.pretrained import get_model

    model_name = str(payload["modelName"])
    model_repo_path = Path(str(payload["modelRepoPath"]))
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
        raise RuntimeError("PCM input file missing: {}".format(pcm_path))
    if samplerate <= 0 or channels <= 0:
        raise RuntimeError("Invalid PCM metadata: samplerate={} channels={}".format(samplerate, channels))

    raw = np.fromfile(pcm_path, dtype=np.float32)
    expected_samples = max(0, total_frames * channels)
    if expected_samples and raw.size != expected_samples:
        raise RuntimeError(
            "PCM sample count mismatch: expected {} got {}".format(expected_samples, raw.size)
        )
    if raw.size % channels != 0:
        raise RuntimeError("PCM sample count is not divisible by channels.")

    if raw.size == 0:
        raise RuntimeError("PCM input is empty.")

    wav = th.from_numpy(raw.reshape(-1, channels).transpose()).float()
    model = get_model(name=model_name, repo=model_repo_path)

    max_allowed_segment = float("inf")
    if isinstance(model, HTDemucs):
        max_allowed_segment = float(model.segment)
    elif isinstance(model, BagOfModels):
        max_allowed_segment = model.max_allowed_segment

    if segment_sec is not None:
        segment_sec = float(segment_sec)
        if segment_sec > max_allowed_segment:
            raise RuntimeError(
                "Cannot use segment {} with model {}, maximum is {}".format(
                    segment_sec, model_name, max_allowed_segment
                )
            )

    model.cpu()
    model.eval()
    wav = convert_audio(wav, samplerate, model.samplerate, model.audio_channels)

    ref = wav.mean(0)
    wav = wav - ref.mean()
    wav = wav / ref.std()

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
    sources = sources * ref.std()
    sources = sources + ref.mean()

    target_dir = output_dir / model_name
    for source, name in zip(sources, model.sources):
        _save_wav(target_dir / "{}.wav".format(name), source, model.samplerate)


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("Missing argv payload for demucs bootstrap.")

    payload = json.loads(sys.argv[1])

    _patch_torch_load()
    _maybe_import_directml()
    if isinstance(payload, list) and payload:
        argv = [str(item) for item in payload]
        _run_cli_mode(argv)
        return
    if isinstance(payload, dict) and payload.get("mode") == "waveform_inference":
        _run_waveform_mode(payload)
        return
    raise RuntimeError("Invalid argv payload for demucs bootstrap.")


if __name__ == "__main__":
    main()
