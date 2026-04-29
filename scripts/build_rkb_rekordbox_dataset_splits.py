import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_TRUTH = BENCHMARK_OUTPUT_DIR / "rekordbox-current-truth.json"
DEFAULT_CLASSIFICATION = BENCHMARK_OUTPUT_DIR / "frkb-classification-current.json"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().casefold()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _track_key(track: dict[str, Any]) -> str:
    return _normalize_text(track.get("fileName"))


def _classification_map(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload = _load_json(path)
    result: dict[str, str] = {}
    for row in payload.get("tracks") or []:
        if not isinstance(row, dict):
            continue
        key = _normalize_text(row.get("fileName"))
        category = _normalize_text(row.get("category"))
        if key and category:
            result[key] = category
    return result


def _source_cluster(track: dict[str, Any]) -> str:
    artist = _normalize_text(track.get("artist"))
    if artist:
        return f"artist:{artist}"
    file_path = str(track.get("filePath") or "").replace("\\", "/")
    parts = [item for item in file_path.split("/") if item]
    if len(parts) >= 2:
        return f"source:{parts[-2].casefold()}"
    return f"file:{_normalize_text(track.get('fileName'))}"


def _cluster_key(track: dict[str, Any], categories: dict[str, str]) -> str:
    key = _track_key(track)
    category = categories.get(key, "unknown")
    return f"{category}|{_source_cluster(track)}"


def _stable_unit_interval(text: str, seed: str) -> float:
    digest = hashlib.sha256(f"{seed}\0{text}".encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(0xFFFFFFFFFFFF)


def _assign_split(cluster_key: str, seed: str, tune_ratio: float, holdout_ratio: float) -> str:
    value = _stable_unit_interval(cluster_key, seed)
    if value < holdout_ratio:
        return "holdout"
    if value < holdout_ratio + tune_ratio:
        return "tune"
    return "train"


def _build_split_truth(base_truth: dict[str, Any], tracks: list[dict[str, Any]], split: str) -> dict[str, Any]:
    payload = {
        key: value
        for key, value in base_truth.items()
        if key not in {"tracks", "trackCount", "sourcePlaylists"}
    }
    payload["type"] = "rkb-rekordbox-truth-split"
    payload["split"] = split
    payload["trackCount"] = len(tracks)
    payload["tracks"] = tracks
    return payload


def build_splits(
    truth_path: Path,
    classification_path: Path,
    *,
    seed: str,
    tune_ratio: float,
    holdout_ratio: float,
) -> dict[str, Any]:
    truth = _load_json(truth_path)
    tracks = [item for item in truth.get("tracks") or [] if isinstance(item, dict) and _track_key(item)]
    categories = _classification_map(classification_path)
    clusters: dict[str, list[dict[str, Any]]] = {}
    for track in tracks:
        clusters.setdefault(_cluster_key(track, categories), []).append(track)

    assignments: dict[str, str] = {}
    split_tracks: dict[str, list[dict[str, Any]]] = {"train": [], "tune": [], "holdout": []}
    for cluster_key in sorted(clusters):
        split = _assign_split(cluster_key, seed, tune_ratio, holdout_ratio)
        assignments[cluster_key] = split
        split_tracks[split].extend(clusters[cluster_key])

    for split in split_tracks:
        split_tracks[split].sort(key=_track_key)

    cluster_rows = [
        {
            "cluster": cluster_key,
            "split": split,
            "trackCount": len(clusters[cluster_key]),
        }
        for cluster_key, split in sorted(assignments.items())
    ]
    return {
        "type": "rkb-rekordbox-dataset-splits",
        "seed": seed,
        "truthPath": str(truth_path),
        "classificationPath": str(classification_path) if classification_path.exists() else None,
        "splitPolicy": {
            "clusterKey": "category + artist/source",
            "tuneRatio": tune_ratio,
            "holdoutRatio": holdout_ratio,
        },
        "summary": {
            "trackCount": len(tracks),
            "clusterCount": len(clusters),
            "train": len(split_tracks["train"]),
            "tune": len(split_tracks["tune"]),
            "holdout": len(split_tracks["holdout"]),
        },
        "clusters": cluster_rows,
        "splits": {
            split: [_track_key(track) for track in split_tracks[split]]
            for split in ("train", "tune", "holdout")
        },
        "truthSplits": {
            split: _build_split_truth(truth, split_tracks[split], split)
            for split in ("train", "tune", "holdout")
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build cluster splits for Rekordbox grid validation")
    parser.add_argument("--truth", default=str(DEFAULT_TRUTH))
    parser.add_argument("--classification", default=str(DEFAULT_CLASSIFICATION))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--seed", default="frkb-rkb-grid-v1")
    parser.add_argument("--tune-ratio", type=float, default=0.2)
    parser.add_argument("--holdout-ratio", type=float, default=0.2)
    parser.add_argument("--write-truth-files", action="store_true")
    args = parser.parse_args()

    payload = build_splits(
        Path(args.truth),
        Path(args.classification),
        seed=str(args.seed),
        tune_ratio=max(0.0, min(0.8, float(args.tune_ratio))),
        holdout_ratio=max(0.0, min(0.8, float(args.holdout_ratio))),
    )
    output_path = Path(args.output)
    truth_splits = payload.pop("truthSplits")
    _write_json(output_path, payload)
    if args.write_truth_files:
        for split, split_payload in truth_splits.items():
            _write_json(output_path.with_name(f"{output_path.stem}-{split}-truth.json"), split_payload)
    print(json.dumps({"output": str(output_path), "summary": payload["summary"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
