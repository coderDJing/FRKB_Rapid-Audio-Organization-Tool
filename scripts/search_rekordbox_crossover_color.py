import argparse
import json
import sys
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from compare_rekordbox_waveform_reference import (  # noqa: E402
    _decode_audio_stereo,
    _load_sampler_loop_rows,
)
from render_rekordbox_waveform_contact import (  # noqa: E402
    DEFAULT_FFMPEG,
    DEFAULT_REKORDBOX_DB,
    _compute_app_raw_mean_signal,
    _first_nonzero,
    _load_pwv5_color_rows,
    _load_selected_rows,
    _load_selection_rows,
    _next_power_of_two,
    _selection_track_ids,
    _app_rgb_height_amp,
    _height_metrics_values,
)
from diagnose_rekordbox_dephased_color_height import _build_candidate

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SELECTION = REPO_ROOT / "out" / "research" / "rekordbox-simple-window-candidates.json"
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-crossover-color-search.json"
SR = 44100
RAW_RATE = 4800.0
ENTRIES = 360
RADIUS = 6
EPS = 1e-9
RAW_FFT_MIN = 128
RAW_FFT_MAX = 512


def _band_ratios(signal: np.ndarray, sr: float, start: int, end: int, low_r: float, mid_r: float) -> np.ndarray:
    span = max(1, end - start + 1)
    size = _next_power_of_two(max(RAW_FFT_MIN, min(RAW_FFT_MAX, span)))
    center = (start + end) // 2
    half = size // 2
    w = np.zeros(size)
    for i in range(size):
        s = center - half + i
        if 0 <= s < signal.size:
            w[i] = signal[s]
    if size > 1:
        w *= np.hanning(size)
    spec = np.fft.rfft(w)
    mag = spec.real * spec.real + spec.imag * spec.imag
    nyq = sr * 0.5
    lo = max(80.0, nyq * low_r)
    mi = max(lo + 60.0, nyq * mid_r)
    b = np.zeros(3)
    for k in range(1, mag.size):
        f = (k * sr) / size
        if f <= lo:
            b[0] += mag[k]
        elif f <= mi:
            b[1] += mag[k]
        else:
            b[2] += mag[k]
    b = np.sqrt(np.maximum(b, 0.0))
    return b / max(float(np.max(b)), EPS)


def _quad(feats: np.ndarray) -> np.ndarray:
    low, mid, high = feats[:, 0], feats[:, 1], feats[:, 2]
    return np.column_stack(
        [np.ones_like(low), low, mid, high, low * low, mid * mid, high * high, low * mid, low * high, mid * high]
    )


def _fit(X, Y, w, lam=0.05):
    sw = np.sqrt(w)
    Xw = X * sw[:, None]
    Yw = Y * sw[:, None]
    reg = lam * np.eye(X.shape[1])
    reg[0, 0] = 0.0
    return np.linalg.solve(Xw.T @ Xw + reg, Xw.T @ Yw)


def _cv_mae(feats, Y, w, tracks, lam=0.05):
    X = _quad(feats)
    pred = np.zeros_like(Y)
    for t in np.unique(tracks):
        te = tracks == t
        tr = ~te
        beta = _fit(X[tr], Y[tr], w[tr], lam)
        pred[te] = np.clip(X[te] @ beta, 0.0, 1.0)
    return float(np.mean(np.abs(pred - Y))), [float(np.mean(np.abs(pred[:, c] - Y[:, c]))) for c in range(3)]


def _aligned_shift(reference, shaped, start, end, radius):
    best_shift = 0
    best = _height_metrics_values(reference[start:end], shaped[start:end])["heightActiveMae"]
    for shift in range(-radius, radius + 1):
        i0 = max(start, -shift)
        i1 = min(end, shaped.size - shift)
        if i1 - i0 < (end - start) // 2:
            continue
        mae = _height_metrics_values(reference[i0:i1], shaped[i0 + shift : i1 + shift])["heightActiveMae"]
        if mae < best - 1e-6:
            best = mae
            best_shift = shift
    return best_shift


def main() -> int:
    parser = argparse.ArgumentParser(description="Search FFT crossover ratios that make Rekordbox color most predictable.")
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--selection-json", default=str(DEFAULT_SELECTION))
    parser.add_argument("--selection-limit", type=int, default=16)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    sel = _load_selection_rows(args.selection_json, args.selection_limit)
    starts = {t: max(0, int(r.get("startIndex") or 0)) for r in sel for t in _selection_track_ids([r])}
    tids = _selection_track_ids(sel)
    selected = _load_selected_rows(args, tids)
    colors = _load_pwv5_color_rows(args, set(tids))
    sampler = _load_sampler_loop_rows(args)
    sampler_colors = _load_pwv5_color_rows(args, {int(m["track"].get("trackId") or 0) for m, _ in sampler})

    # Pre-decode each track once; store mono + per-entry pcm windows + shift + reference colors.
    cache = []
    sources = [("simple", m, r, starts.get(int(m["track"].get("trackId") or 0), max(0, _first_nonzero(r) - 18)), colors)
               for m, r in selected]
    sources += [("sampler", m, r, max(0, _first_nonzero(r) - 18), sampler_colors) for m, r in sampler]
    for gi, (group, metadata, reference, start, cmap) in enumerate(sources):
        tid = int(metadata["track"].get("trackId") or 0)
        rc = cmap.get(tid)
        if rc is None:
            continue
        audio = Path(str(metadata["track"].get("filePath") or ""))
        if not audio.exists():
            continue
        stereo = _decode_audio_stereo(Path(args.ffmpeg), audio, SR)
        n = int(reference.size)
        cand = _build_candidate(n, stereo, SR, RAW_RATE)
        mono = _compute_app_raw_mean_signal(stereo, SR, RAW_RATE)
        s = max(0, min(max(0, n - ENTRIES), start))
        e = min(n, s + ENTRIES)
        # shift via current-crossover heights (shift is crossover-independent enough)
        shaped = cand.copy()
        windows = {}
        for entry in range(max(0, s - RADIUS), min(n, e + RADIUS)):
            ps = int(round((entry / n) * mono.size))
            pe = max(ps, int(round(((entry + 1) / n) * mono.size)) - 1)
            windows[entry] = (ps, pe)
            br = _band_ratios(mono, RAW_RATE, ps, pe, 0.14, 0.54)
            shaped[entry] = _app_rgb_height_amp(float(cand[entry]), br)
        shift = _aligned_shift(reference, shaped, s, e, RADIUS) if group == "simple" else 0
        rows = []
        for entry in range(s, e):
            src = entry + shift
            if src not in windows or reference[entry] <= 0.02:
                continue
            rows.append((windows[src][0], windows[src][1], rc[entry]))
        if rows:
            cache.append({"group": group, "track": gi, "mono": mono, "rows": rows})

    grid = [(lr, mr) for lr in (0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.14)
            for mr in (0.35, 0.42, 0.5, 0.54, 0.6)]
    results = []
    for (lr, mr) in grid:
        feats, targets, weights, tracks, groups = [], [], [], [], []
        for c in cache:
            mono = c["mono"]
            for ps, pe, tgt in c["rows"]:
                br = _band_ratios(mono, RAW_RATE, ps, pe, lr, mr)
                feats.append(br)
                targets.append(tgt)
                weights.append(1.0)
                tracks.append(c["track"])
                groups.append(c["group"])
        feats = np.asarray(feats)
        targets = np.asarray(targets)
        weights = np.asarray(weights)
        tracks = np.asarray(tracks)
        groups = np.asarray(groups)
        cv, ch = _cv_mae(feats, targets, weights, tracks)
        simple_m = groups == "simple"
        sampler_m = groups == "sampler"
        cv_s, _ = _cv_mae(feats[simple_m], targets[simple_m], weights[simple_m], tracks[simple_m])
        cv_l, _ = _cv_mae(feats[sampler_m], targets[sampler_m], weights[sampler_m], tracks[sampler_m])
        results.append({"low": lr, "mid": mr, "cvMae": cv, "cvSimple": cv_s, "cvSampler": cv_l, "cvChannel": ch})

    results.sort(key=lambda r: r["cvMae"])
    Path(args.output).write_text(json.dumps({"grid": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("low   mid   cvMae   simple  sampler  ch(r,g,b)")
    for r in results[:14]:
        ch = ",".join(f"{x:.3f}" for x in r["cvChannel"])
        print(f"{r['low']:.2f}  {r['mid']:.2f}  {r['cvMae']:.4f}  {r['cvSimple']:.4f}  {r['cvSampler']:.4f}  {ch}")
    print("\nCURRENT (0.14,0.54) for reference is in the list above.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
