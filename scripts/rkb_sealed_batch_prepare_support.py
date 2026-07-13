from pathlib import Path
from typing import Any

from rkb_playlist_triage_report import load_report_for_apply
from rkb_sealed_batch_common import (
    SealedBatchError,
    build_audio_roster,
    load_json,
    normalize_name,
    registry_identity_index,
    resolve_executable,
    sha256_file,
    truth_tracks,
    write_json_atomic,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


def acceptance_policy(args: Any) -> dict[str, Any]:
    policy = {
        "version": 1,
        "minimumStrictAccuracy": float(args.minimum_strict_accuracy),
        "maximumErrorRate": float(args.maximum_error_rate),
        "maximumBpmBigErrorRate": float(args.maximum_bpm_big_error_rate),
        "minimumCandidateOracleRate": float(args.minimum_candidate_oracle_rate),
        "promotionSemantics": "passing creates eligible status only; production promotion is external",
    }
    for name in (
        "minimumStrictAccuracy",
        "maximumErrorRate",
        "maximumBpmBigErrorRate",
        "minimumCandidateOracleRate",
    ):
        value = float(policy[name])
        if not 0.0 <= value <= 1.0:
            raise SealedBatchError(f"acceptance policy {name} must be between 0 and 1")
    if float(policy["maximumErrorRate"]) != 0.0:
        raise SealedBatchError("sealed acceptance requires maximumErrorRate = 0")
    return policy


def evaluate_policy(summary: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    total = int(summary.get("trackTotal") or 0)
    categories = summary.get("categoryCounts") if isinstance(summary.get("categoryCounts"), dict) else {}
    pass_count = int(categories.get("pass") or 0)
    error_count = int(summary.get("errorTrackCount") or 0)
    bpm_big_error_count = int(summary.get("bpmBigErrorCount") or 0)
    strict_accuracy = pass_count / max(1, total)
    error_rate = error_count / max(1, total)
    bpm_big_error_rate = bpm_big_error_count / max(1, total)
    oracle = summary.get("candidateOracle") if isinstance(summary.get("candidateOracle"), dict) else {}
    oracle_rate = float(oracle.get("candidatePassRate") or 0.0)
    gates = {
        "minimumStrictAccuracy": strict_accuracy >= float(policy["minimumStrictAccuracy"]),
        "maximumErrorRate": error_rate <= float(policy["maximumErrorRate"]),
        "maximumBpmBigErrorRate": bpm_big_error_rate <= float(policy["maximumBpmBigErrorRate"]),
        "minimumCandidateOracleRate": oracle_rate >= float(policy["minimumCandidateOracleRate"]),
    }
    return {
        "passed": all(gates.values()),
        "gates": gates,
        "metrics": {
            "strictAccuracy": round(strict_accuracy, 9),
            "errorRate": round(error_rate, 9),
            "bpmBigErrorRate": round(bpm_big_error_rate, 9),
            "candidateOracleRate": round(oracle_rate, 9),
        },
        "policy": policy,
    }


def identity_tool(args: Any) -> dict[str, Any]:
    node = resolve_executable(args.node)
    helper = Path(args.identity_helper).resolve()
    if not helper.is_file():
        raise SealedBatchError(f"audio identity helper not found: {helper}")
    max_length_seconds = int(args.identity_max_seconds)
    if max_length_seconds <= 0:
        raise SealedBatchError("--identity-max-seconds must be positive")
    chunk_size = int(args.identity_chunk_size)
    if chunk_size <= 0:
        raise SealedBatchError("--identity-chunk-size must be positive")
    cache_value = str(args.identity_cache_dir or "").strip()
    cache_dir = Path(cache_value).resolve() if cache_value else None
    return {
        "node": node,
        "helperPath": str(helper),
        "helperSha256": sha256_file(helper),
        "maxLengthSeconds": max_length_seconds,
        "cacheDir": str(cache_dir) if cache_dir is not None else "",
        "cacheSchemaVersion": 1,
        "chunkSize": chunk_size,
        "pcmHash": "rust_package.calculateAudioHashes",
        "fingerprint": "rust_package.generateChromaprintFingerprint",
        "failurePolicy": "hard-error",
    }


def load_reviewed_development_report(args: Any) -> tuple[Path, dict[str, Any]] | None:
    reviewed_development = bool(getattr(args, "reviewed_development", False))
    raw_path = str(getattr(args, "triage_report", "") or "").strip()
    if not reviewed_development:
        if raw_path:
            raise SealedBatchError("--triage-report requires --reviewed-development")
        return None
    if not raw_path:
        raise SealedBatchError("--reviewed-development requires --triage-report")
    report_path = Path(raw_path).resolve()
    if not report_path.is_file():
        raise SealedBatchError(f"pre-review triage report not found: {report_path}")
    try:
        report = load_report_for_apply(report_path)
    except RuntimeError as error:
        raise SealedBatchError(f"invalid pre-review triage report: {error}") from error
    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    guard = report.get("workflowGuard") if isinstance(report.get("workflowGuard"), dict) else {}
    if str(summary.get("mode") or "") != "dry-run":
        raise SealedBatchError("pre-review triage report must be a dry-run")
    if int(summary.get("errorTrackCount") or 0) != 0:
        raise SealedBatchError("pre-review triage report contains analysis errors")
    if str(guard.get("mode") or "") != "pre-review-label-qa":
        raise SealedBatchError("reviewed development requires a pre-review label-QA report")
    return report_path, report


def verify_reviewed_development_roster(*, report: dict[str, Any], roster: list[dict[str, Any]]) -> None:
    batch = report.get("batch") if isinstance(report.get("batch"), dict) else {}
    guard = report.get("workflowGuard") if isinstance(report.get("workflowGuard"), dict) else {}
    entries = batch.get("denominatorEntries") if isinstance(batch.get("denominatorEntries"), list) else []
    identities = (
        guard.get("denominatorAudioIdentities")
        if isinstance(guard.get("denominatorAudioIdentities"), list)
        else []
    )
    expected_names = {normalize_name(item.get("fileName")) for item in entries if isinstance(item, dict)}
    expected_assets = {
        normalize_name(item.get("fileName")): str(item.get("assetSha256") or "").strip().casefold()
        for item in identities
        if isinstance(item, dict)
    }
    actual_assets = {
        normalize_name(item.get("fileName")): str(item.get("assetSha256") or "").strip().casefold()
        for item in roster
    }
    if not expected_names or expected_names != set(expected_assets):
        raise SealedBatchError("pre-review report roster is incomplete")
    if expected_names != set(actual_assets):
        raise SealedBatchError(
            "review playlist must contain exactly the complete pre-review batch; "
            "missing or extra tracks are forbidden"
        )
    mismatched = [
        name for name in sorted(expected_names) if expected_assets[name] != actual_assets.get(name)
    ]
    if mismatched:
        raise SealedBatchError(
            "review playlist audio differs from the pre-review report: " + ", ".join(mismatched[:8])
        )


def reviewed_report_file_names(report: dict[str, Any]) -> list[str]:
    batch = report.get("batch") if isinstance(report.get("batch"), dict) else {}
    entries = batch.get("denominatorEntries") if isinstance(batch.get("denominatorEntries"), list) else []
    names = [str(item.get("fileName") or "").strip() for item in entries if isinstance(item, dict)]
    normalized = [normalize_name(name) for name in names]
    if not names or any(not name for name in normalized) or len(set(normalized)) != len(normalized):
        raise SealedBatchError("pre-review report has no complete unique filename roster")
    return names


def build_roster(paths: list[Path], identity: dict[str, Any], *, include_source: bool = False) -> list[dict[str, Any]]:
    return build_audio_roster(
        audio_paths=paths,
        node_executable=str(identity["node"]),
        helper_path=Path(str(identity["helperPath"])),
        max_length_seconds=int(identity["maxLengthSeconds"]),
        repo_root=REPO_ROOT,
        include_source_path=include_source,
        identity_cache_dir=(Path(str(identity["cacheDir"])) if str(identity.get("cacheDir") or "") else None),
        identity_chunk_size=int(identity.get("chunkSize") or 16),
    )


def filter_registry_duplicates(
    *, truth_path: Path, audio_root: Path, roster: list[dict[str, Any]], registry: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    identity_index = registry_identity_index(registry)
    truth = load_json(truth_path)
    tracks = truth_tracks(truth, truth_path)
    track_by_name = {normalize_name(item.get("fileName")): item for item in tracks}
    kept: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    batch_seen = {key: {} for key in identity_index}
    for item in sorted(roster, key=lambda row: normalize_name(row.get("fileName"))):
        matches: list[dict[str, str]] = []
        matched_by = ""
        for key in ("assetSha256", "pcmSha256", "fingerprintSha256"):
            value = str(item.get(key) or "")
            if value and value in identity_index[key]:
                matches.extend(identity_index[key][value])
                matched_by = key
                break
            if value and value in batch_seen[key]:
                matches.append({"batchId": "current-batch", "fileName": batch_seen[key][value]})
                matched_by = key
                break
        if matched_by:
            excluded.append({**item, "reason": f"duplicate-{matched_by}", "matches": matches})
            path = audio_root / str(item.get("fileName") or "")
            if path.is_file():
                path.unlink()
            continue
        for key in batch_seen:
            value = str(item.get(key) or "")
            if value:
                batch_seen[key][value] = str(item.get("fileName") or "")
        kept.append(item)
    if not kept:
        raise SealedBatchError("sealed batch contains no unseen tracks after registry duplicate checks")
    kept_names = {normalize_name(item.get("fileName")) for item in kept}
    filtered_tracks = [track_by_name[key] for key in track_by_name if key in kept_names]
    if len(filtered_tracks) != len(kept):
        raise SealedBatchError("failed to align registry-filtered truth and audio")
    truth["tracks"] = filtered_tracks
    source = truth.get("source") if isinstance(truth.get("source"), dict) else {}
    truth["source"] = {
        **source,
        "trackCount": len(filtered_tracks),
        "sealedBatchExcludedRegistryDuplicateCount": len(excluded),
    }
    write_json_atomic(truth_path, truth)
    return kept, excluded
