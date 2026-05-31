import argparse
import json
import sys
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from compare_rekordbox_waveform_reference import _decode_audio_stereo, _load_sampler_loop_rows  # noqa: E402
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
    _height_metrics_values,
    APP_RGB_HEIGHT_BLEND,
    APP_RGB_HEIGHT_MIN,
    APP_RGB_HEIGHT_MAX,
    APP_RGB_HEIGHT_MODEL,
)
from diagnose_rekordbox_dephased_color_height import _build_candidate

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SELECTION = REPO_ROOT / "out" / "research" / "rekordbox-simple-window-candidates.json"
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-recrossover-refit-summary.json"
SR = 44100
RAW_RATE = 4800.0
ENTRIES = 360
RADIUS = 6
EPS = 1e-9


def _band_ratios(sig, sr, a, b, lo_r, mi_r):
    span = max(1, b - a + 1)
    size = _next_power_of_two(max(128, min(512, span)))
    center = (a + b) // 2
    half = size // 2
    w = np.zeros(size)
    for i in range(size):
        s = center - half + i
        if 0 <= s < sig.size:
            w[i] = sig[s]
    if size > 1:
        w *= np.hanning(size)
    sp = np.fft.rfft(w)
    mag = sp.real * sp.real + sp.imag * sp.imag
    nyq = sr * 0.5
    lo = max(80.0, nyq * lo_r)
    mi = max(lo + 60.0, nyq * mi_r)
    bd = np.zeros(3)
    for k in range(1, mag.size):
        f = (k * sr) / size
        if f <= lo:
            bd[0] += mag[k]
        elif f <= mi:
            bd[1] += mag[k]
        else:
            bd[2] += mag[k]
    bd = np.sqrt(np.maximum(bd, 0.0))
    return bd / max(float(np.max(bd)), EPS)


def _height_feats(ratios: np.ndarray, amp: np.ndarray) -> np.ndarray:
    low, mid, high = ratios[:, 0], ratios[:, 1], ratios[:, 2]
    a = np.clip(amp, 0.0, 1.0)
    return np.column_stack(
        [np.ones_like(low), low, mid, high, low * low, mid * mid, high * high, low * mid, low * high, mid * high, a, a * a]
    )


def _apply_height_model(amp: np.ndarray, ratios: np.ndarray, model: np.ndarray, blend: float) -> np.ndarray:
    a = np.clip(amp, 0.0, 1.0)
    feat = _height_feats(ratios, a)
    mult = np.clip(np.exp(feat @ model), APP_RGB_HEIGHT_MIN, APP_RGB_HEIGHT_MAX)
    adj = np.clip(a * mult, 0.0, 1.0)
    return np.clip(a * (1.0 - blend) + adj * blend, 0.0, 1.0)


def _quad(F):
    l, m, h = F[:, 0], F[:, 1], F[:, 2]
    return np.column_stack([np.ones_like(l), l, m, h, l * l, m * m, h * h, l * m, l * h, m * h])


def _fit_ridge(X, Y, lam=0.05):
    reg = lam * np.eye(X.shape[1])
    reg[0, 0] = 0.0
    return np.linalg.solve(X.T @ X + reg, X.T @ Y)


def main() -> int:
    parser = argparse.ArgumentParser(description="Refit color+height at a new FFT crossover and CV-compare to current.")
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--selection-json", default=str(DEFAULT_SELECTION))
    parser.add_argument("--selection-limit", type=int, default=16)
    parser.add_argument("--low", type=float, default=0.05)
    parser.add_argument("--mid", type=float, default=0.50)
    parser.add_argument("--no-post", action="store_true", help="Disable post scale/bias (matrix-only color)")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    sel = _load_selection_rows(args.selection_json, args.selection_limit)
    starts = {t: max(0, int(r.get("startIndex") or 0)) for r in sel for t in _selection_track_ids([r])}
    tids = _selection_track_ids(sel)
    selected = _load_selected_rows(args, tids)
    colors = _load_pwv5_color_rows(args, set(tids))
    sampler = _load_sampler_loop_rows(args)
    scolors = _load_pwv5_color_rows(args, {int(m["track"].get("trackId") or 0) for m, _ in sampler})

    # Build per-track aligned samples at the NEW crossover. Alignment uses the CURRENT height model
    # at the OLD crossover (alignment is essentially crossover-independent; verified separately).
    srcs = [("simple", m, r, starts.get(int(m["track"].get("trackId") or 0), max(0, _first_nonzero(r) - 18)), colors) for m, r in selected]
    srcs += [("sampler", m, r, max(0, _first_nonzero(r) - 18), scolors) for m, r in sampler]

    samples = []  # dict per track: ratios(new), amp(base candidate), refHeight, refColor, group, track
    for gi, (grp, md, ref, st, cm) in enumerate(srcs):
        tid = int(md["track"].get("trackId") or 0)
        rc = cm.get(tid)
        if rc is None:
            continue
        audio = Path(str(md["track"].get("filePath") or ""))
        if not audio.exists():
            continue
        stereo = _decode_audio_stereo(Path(args.ffmpeg), audio, SR)
        n = int(ref.size)
        cand = _build_candidate(n, stereo, SR, RAW_RATE)
        mono = _compute_app_raw_mean_signal(stereo, SR, RAW_RATE)
        s = max(0, min(max(0, n - ENTRIES), st))
        e = min(n, s + ENTRIES)
        # alignment shift using CURRENT model at OLD crossover
        old_shaped = cand.copy()
        win = {}
        new_ratios = {}
        for entry in range(max(0, s - RADIUS), min(n, e + RADIUS)):
            ps = int(round((entry / n) * mono.size))
            pe = max(ps, int(round(((entry + 1) / n) * mono.size)) - 1)
            win[entry] = (ps, pe)
            old_r = _band_ratios(mono, RAW_RATE, ps, pe, 0.14, 0.54)
            new_ratios[entry] = _band_ratios(mono, RAW_RATE, ps, pe, args.low, args.mid)
            old_shaped[entry] = _apply_height_model(np.array([cand[entry]]), old_r[None, :], APP_RGB_HEIGHT_MODEL, APP_RGB_HEIGHT_BLEND)[0]
        shift = 0
        bm = _height_metrics_values(ref[s:e], old_shaped[s:e])["heightActiveMae"]
        if grp == "simple":
            for sh in range(-RADIUS, RADIUS + 1):
                i0 = max(s, -sh)
                i1 = min(e, old_shaped.size - sh)
                if i1 - i0 < (e - s) // 2:
                    continue
                mm = _height_metrics_values(ref[i0:i1], old_shaped[i0 + sh : i1 + sh])["heightActiveMae"]
                if mm < bm - 1e-6:
                    bm = mm
                    shift = sh
        rows = []
        for entry in range(s, e):
            src = entry + shift
            if src not in new_ratios or ref[entry] <= 0.02:
                continue
            rows.append((new_ratios[src], float(cand[src]), float(ref[entry]), rc[entry]))
        if rows:
            samples.append({"group": grp, "track": gi, "rows": rows})

    # ---- HEIGHT refit (CV leave-one-track-out) ----
    # target multiplier: solve for model so that a*(1-blend)+clip(a*exp(feat@model))*blend ≈ refHeight.
    # We fit exp(feat@model) ≈ refHeight/a on active entries (a>gate), weighted by a. Linearize: log(target_mult).
    def height_dataset():
        F = []
        logm = []
        w = []
        tr = []
        for s_ in samples:
            for ratios, amp, refH, _ in s_["rows"]:
                a = max(1e-3, min(1.0, amp))
                if a < 0.05:
                    continue
                target_mult = max(0.2, min(3.0, refH / a))
                F.append(_height_feats(ratios[None, :], np.array([a]))[0])
                logm.append(np.log(target_mult))
                w.append(a)
                tr.append(s_["track"])
        return np.asarray(F), np.asarray(logm), np.asarray(w), np.asarray(tr)

    HF, Hlog, Hw, Htr = height_dataset()

    def fit_height(mask):
        sw = np.sqrt(Hw[mask])
        Xw = HF[mask] * sw[:, None]
        Yw = Hlog[mask] * sw
        reg = 0.1 * np.eye(HF.shape[1])
        reg[0, 0] = 0.0
        return np.linalg.solve(Xw.T @ Xw + reg, Xw.T @ Yw)

    # measure height activeMae per track with a given model at NEW crossover
    def height_active_mae(model, blend):
        per = {"simple": [], "sampler": []}
        for s_ in samples:
            ratios = np.asarray([r[0] for r in s_["rows"]])
            amp = np.asarray([r[1] for r in s_["rows"]])
            refH = np.asarray([r[2] for r in s_["rows"]])
            shaped = _apply_height_model(amp, ratios, model, blend)
            active = refH > 0.02
            if np.any(active):
                per[s_["group"]].append(float(np.mean(np.abs(shaped[active] - refH[active]))))
        return float(np.mean(per["simple"])) if per["simple"] else 0.0, float(np.mean(per["sampler"])) if per["sampler"] else 0.0

    # CV new height model
    refit_full = fit_height(np.ones(HF.shape[0], dtype=bool))
    # current model height at new crossover
    cur_h_simple, cur_h_sampler = height_active_mae(APP_RGB_HEIGHT_MODEL, APP_RGB_HEIGHT_BLEND)
    new_h_simple, new_h_sampler = height_active_mae(refit_full, APP_RGB_HEIGHT_BLEND)

    # ---- COLOR refit (CV leave-one-track-out, matrix + per-channel post) ----
    def color_dataset():
        F = []
        Y = []
        tr = []
        g = []
        for s_ in samples:
            for ratios, _amp, _refH, refC in s_["rows"]:
                F.append(ratios)
                Y.append(refC)
                tr.append(s_["track"])
                g.append(s_["group"])
        return np.asarray(F), np.asarray(Y), np.asarray(tr), np.asarray(g)

    CF, CY, Ctr, Cg = color_dataset()
    Xc = _quad(CF)
    scales = np.array([1.0]) if args.no_post else np.linspace(0.7, 1.8, 45)
    biases = np.array([0.0]) if args.no_post else np.linspace(-0.25, 0.15, 41)
    pred = np.zeros_like(CY)
    for t in np.unique(Ctr):
        te = Ctr == t
        trn = ~te
        beta = _fit_ridge(Xc[trn], CY[trn])
        raw_tr = np.clip(Xc[trn] @ beta, 0, 1)
        raw_te = np.clip(Xc[te] @ beta, 0, 1)
        for ch in range(3):
            best = (1e9, 1.0, 0.0)
            for sc in scales:
                for b in biases:
                    p = np.clip(raw_tr[:, ch] * sc + b, 0, 1)
                    err = float(np.mean(np.abs(p - CY[trn, ch])))
                    if err < best[0]:
                        best = (err, sc, b)
            pred[te, ch] = np.clip(raw_te[:, ch] * best[1] + best[2], 0, 1)
    color_cv = float(np.mean(np.abs(pred - CY)))
    color_cv_simple = float(np.mean(np.abs(pred[Cg == "simple"] - CY[Cg == "simple"])))
    color_cv_sampler = float(np.mean(np.abs(pred[Cg == "sampler"] - CY[Cg == "sampler"])))

    # final production constants: fit matrix + post on ALL data
    beta_all = _fit_ridge(Xc, CY)
    raw_all = np.clip(Xc @ beta_all, 0, 1)
    final_scale = []
    final_bias = []
    for ch in range(3):
        best = (1e9, 1.0, 0.0)
        for sc in scales:
            for b in biases:
                p = np.clip(raw_all[:, ch] * sc + b, 0, 1)
                err = float(np.mean(np.abs(p - CY[:, ch])))
                if err < best[0]:
                    best = (err, sc, b)
        final_scale.append(best[1])
        final_bias.append(best[2])

    payload = {
        "crossover": {"low": args.low, "mid": args.mid},
        "height": {
            "currentModel": {"simpleActiveMae": cur_h_simple, "samplerActiveMae": cur_h_sampler},
            "refitModel": {"simpleActiveMae": new_h_simple, "samplerActiveMae": new_h_sampler},
            "refitHeightModel": refit_full.tolist(),
            "heightBlend": APP_RGB_HEIGHT_BLEND,
        },
        "color": {
            "cvMae": color_cv,
            "cvSimple": color_cv_simple,
            "cvSampler": color_cv_sampler,
            "finalMatrix": beta_all.T.tolist(),
            "finalPostScale": final_scale,
            "finalPostBias": final_bias,
        },
    }
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "crossover": payload["crossover"],
        "heightCurrent": [round(cur_h_simple, 5), round(cur_h_sampler, 5)],
        "heightRefit": [round(new_h_simple, 5), round(new_h_sampler, 5)],
        "colorCV": round(color_cv, 5),
        "colorCVSimple": round(color_cv_simple, 5),
        "colorCVSampler": round(color_cv_sampler, 5),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
