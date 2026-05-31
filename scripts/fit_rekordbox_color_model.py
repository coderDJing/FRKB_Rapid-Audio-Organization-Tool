import argparse
import json
import sys
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = REPO_ROOT / "out" / "research" / "rekordbox-aligned-color-dataset.npz"
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-color-fit-summary.json"


def _linear_features(feats: np.ndarray) -> np.ndarray:
    # feats[:,0]=low, [:,1]=mid, [:,2]=high (band ratios, max-normalized)
    low, mid, high = feats[:, 0], feats[:, 1], feats[:, 2]
    return np.column_stack([np.ones_like(low), low, mid, high])


def _quad_features(feats: np.ndarray) -> np.ndarray:
    low, mid, high = feats[:, 0], feats[:, 1], feats[:, 2]
    return np.column_stack(
        [
            np.ones_like(low),
            low,
            mid,
            high,
            low * low,
            mid * mid,
            high * high,
            low * mid,
            low * high,
            mid * high,
        ]
    )


FEATURE_BUILDERS = {"linear": _linear_features, "quad": _quad_features}


def _fit_ridge(X: np.ndarray, Y: np.ndarray, w: np.ndarray, lam: float) -> np.ndarray:
    # weighted ridge per channel: beta = (X' W X + lam I)^-1 X' W Y  (bias term not penalized)
    sw = np.sqrt(w)
    Xw = X * sw[:, None]
    Yw = Y * sw[:, None]
    n_feat = X.shape[1]
    reg = lam * np.eye(n_feat)
    reg[0, 0] = 0.0  # don't penalize bias
    beta = np.linalg.solve(Xw.T @ Xw + reg, Xw.T @ Yw)
    return beta  # shape (n_feat, 3)


def _predict(X: np.ndarray, beta: np.ndarray) -> np.ndarray:
    return np.clip(X @ beta, 0.0, 1.0)


def _channel_mae(pred: np.ndarray, tgt: np.ndarray) -> list[float]:
    return [float(np.mean(np.abs(pred[:, c] - tgt[:, c]))) for c in range(3)]


def _overall_mae(pred: np.ndarray, tgt: np.ndarray) -> float:
    return float(np.mean(np.abs(pred - tgt)))


def _per_track_mae(pred: np.ndarray, tgt: np.ndarray, tracks: np.ndarray, mask: np.ndarray) -> float:
    tids = np.unique(tracks[mask])
    vals = []
    for t in tids:
        m = mask & (tracks == t)
        if np.any(m):
            vals.append(float(np.mean(np.abs(pred[m] - tgt[m]))))
    return float(np.mean(vals)) if vals else 0.0


def _leave_one_track_out_cv(
    X: np.ndarray, Y: np.ndarray, w: np.ndarray, tracks: np.ndarray, lam: float
) -> np.ndarray:
    pred = np.zeros_like(Y)
    for t in np.unique(tracks):
        test = tracks == t
        train = ~test
        beta = _fit_ridge(X[train], Y[train], w[train], lam)
        pred[test] = _predict(X[test], beta)
    return pred


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit a Rekordbox-like RGB color model on the phase-aligned dataset.")
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    d = np.load(args.dataset, allow_pickle=True)
    feats, targets, weights, groups, tracks = (
        d["feats"],
        d["targets"],
        d["weights"],
        d["groups"],
        d["tracks"],
    )
    simple = groups == "simple"
    sampler = groups == "sampler"

    results = []
    for form in ("linear", "quad"):
        X = FEATURE_BUILDERS[form](feats)
        for lam in (0.0, 0.01, 0.05, 0.1, 0.3, 1.0):
            # train on ALL data
            beta = _fit_ridge(X, targets, weights, lam)
            train_pred = _predict(X, beta)
            # leave-one-track-out CV (true generalization)
            cv_pred = _leave_one_track_out_cv(X, targets, weights, tracks, lam)
            results.append(
                {
                    "form": form,
                    "lambda": lam,
                    "nFeat": int(X.shape[1]),
                    "trainOverallMae": _overall_mae(train_pred, targets),
                    "cvOverallMae": _overall_mae(cv_pred, targets),
                    "cvSimplePerTrackMae": _per_track_mae(cv_pred, targets, tracks, simple),
                    "cvSamplerPerTrackMae": _per_track_mae(cv_pred, targets, tracks, sampler),
                    "trainChannelMae": _channel_mae(train_pred, targets),
                    "cvChannelMae": _channel_mae(cv_pred, targets),
                    "overfitGap": _overall_mae(train_pred, targets) - _overall_mae(cv_pred, targets),
                    "beta": beta.T.tolist(),  # [channel][feature]
                }
            )

    # rank by CV generalization (overall), tie-break by sampler stability
    results.sort(key=lambda r: (r["cvOverallMae"], r["cvSamplerPerTrackMae"]))
    best = results[0]

    payload = {
        "type": "rekordbox-color-fit",
        "datasetRows": int(feats.shape[0]),
        "best": best,
        "all": results,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("form    lam    nF  trainMAE  cvMAE    cvSimple cvSampler  ch(r,g,b)cv")
    for r in results:
        ch = ",".join(f"{x:.3f}" for x in r["cvChannelMae"])
        print(
            f"{r['form']:6s} {r['lambda']:<5} {r['nFeat']:<3} "
            f"{r['trainOverallMae']:.5f}  {r['cvOverallMae']:.5f}  "
            f"{r['cvSimplePerTrackMae']:.4f}   {r['cvSamplerPerTrackMae']:.4f}    {ch}"
        )
    print("\nBEST:", best["form"], "lambda", best["lambda"], "cvMAE", round(best["cvOverallMae"], 5))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
