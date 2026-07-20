import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
READ_CHUNK_SIZE = 4 * 1024 * 1024
MANIFEST_NAME = "manifest.json"
STATE_NAME = "state.json"
SOLVER_LOCK_NAME = "solver-lock.json"
TRUTH_NAME = "truth.json"
BENCHMARK_NAME = "benchmark.json"
FINALIZATION_NAME = "finalization.json"
IDENTITY_CACHE_SCHEMA_VERSION = 1


class SealedBatchError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_json(payload: Any) -> str:
    return sha256_bytes(canonical_json(payload).encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(READ_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SealedBatchError(f"failed to read JSON {path}: {error}") from error
    if not isinstance(payload, dict):
        raise SealedBatchError(f"JSON is not an object: {path}")
    return payload


def write_json_new(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except FileExistsError as error:
        raise SealedBatchError(f"immutable output already exists: {path}") from error


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp_path.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temp_path.replace(path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def normalize_name(value: Any) -> str:
    return str(value or "").strip().casefold()


def resolve_executable(value: str) -> str:
    candidate = Path(str(value or "").strip())
    if candidate.exists():
        return str(candidate.resolve())
    resolved = shutil.which(str(value or "").strip())
    if resolved:
        return str(Path(resolved).resolve())
    raise SealedBatchError(f"executable not found: {value}")


def resolve_checkpoint(python_executable: str, explicit: str, repo_root: Path) -> Path:
    candidates: list[Path] = []
    if str(explicit or "").strip():
        candidates.append(Path(explicit))
    if env_checkpoint := str(os.environ.get("FRKB_BEAT_THIS_CHECKPOINT") or "").strip():
        candidates.append(Path(env_checkpoint))
    candidates.append(Path(python_executable).parent / "beat-this-checkpoints" / "final0.ckpt")
    candidates.append(
        repo_root
        / "vendor"
        / "demucs"
        / "win32-x64"
        / "runtime-cpu"
        / "beat-this-checkpoints"
        / "final0.ckpt"
    )
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved.is_file():
            return resolved
    raise SealedBatchError(f"BeatThis checkpoint not found; checked: {', '.join(map(str, candidates))}")


def run_json_command(command: list[str], repo_root: Path) -> dict[str, Any]:
    result = subprocess.run(command, cwd=repo_root, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise SealedBatchError(f"command failed: {' '.join(command)}\n{detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SealedBatchError(
            f"command did not return one JSON object: {' '.join(command)}\n{result.stdout[-2000:]}"
        ) from error
    if not isinstance(payload, dict):
        raise SealedBatchError(f"command JSON is not an object: {' '.join(command)}")
    return payload


def run_logged_command(command: list[str], stdout_path: Path, stderr_path: Path, repo_root: Path) -> int:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open("x", encoding="utf-8", newline="\n") as stdout_handle:
        with stderr_path.open("x", encoding="utf-8", newline="\n") as stderr_handle:
            result = subprocess.run(
                command,
                cwd=repo_root,
                stdout=stdout_handle,
                stderr=stderr_handle,
                text=True,
                encoding="utf-8",
            )
    return int(result.returncode)


@contextmanager
def exclusive_lock(path: Path, payload: dict[str, Any]):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise SealedBatchError(f"operation lock already exists: {path}") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        yield
    finally:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def path_signature(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        return {"path": str(resolved), "exists": False}
    stat = resolved.stat()
    return {
        "path": str(resolved),
        "exists": True,
        "size": int(stat.st_size),
        "sha256": sha256_file(resolved),
    }


def _required_path_signature(path: Path, label: str) -> dict[str, Any]:
    signature = path_signature(path)
    if not signature.get("exists"):
        raise SealedBatchError(f"locked runtime file not found ({label}): {path}")
    return signature


def _python_runtime_payload(python_executable: str) -> dict[str, Any]:
    probe = (
        "import json,pathlib,platform,sys;"
        "import beat_this,numpy,soxr,torch;"
        "print(json.dumps({"
        "'pythonVersion':sys.version,'platform':platform.platform(),"
        "'beatThisPath':str(pathlib.Path(beat_this.__file__).resolve()),"
        "'beatThisVersion':getattr(beat_this,'__version__',None),"
        "'torchVersion':torch.__version__,'numpyVersion':numpy.__version__,"
        "'soxrVersion':getattr(soxr,'__version__',None)}))"
    )
    result = subprocess.run(
        [python_executable, "-c", probe],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise SealedBatchError(f"failed to probe locked Python runtime: {detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SealedBatchError("locked Python runtime probe returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise SealedBatchError("locked Python runtime probe returned a non-object")
    beat_this_path = Path(str(payload.get("beatThisPath") or ""))
    if not beat_this_path.is_file():
        raise SealedBatchError(f"BeatThis runtime source not found: {beat_this_path}")
    beat_this_sources = sorted(beat_this_path.parent.rglob("*.py"), key=lambda item: str(item).casefold())
    if not beat_this_sources:
        raise SealedBatchError(f"BeatThis runtime contains no Python sources: {beat_this_path.parent}")
    return {
        "probe": payload,
        "beatThisSources": [path_signature(path) for path in beat_this_sources],
    }


def runtime_lock_payload(
    cli_payload: dict[str, Any],
    identity_tool: dict[str, Any],
) -> dict[str, Any]:
    python_executable = str(cli_payload.get("python") or "")
    node_executable = str(identity_tool.get("node") or "")
    files = {
        "python": _required_path_signature(Path(python_executable), "python"),
        "node": _required_path_signature(Path(node_executable), "node"),
        "ffmpeg": _required_path_signature(Path(str(cli_payload.get("ffmpeg") or "")), "ffmpeg"),
        "ffprobe": _required_path_signature(
            Path(str(cli_payload.get("ffprobe") or "")), "ffprobe"
        ),
    }
    return {
        "files": files,
        "pythonPackages": _python_runtime_payload(python_executable),
    }


def _git_output(repo_root: Path, arguments: list[str]) -> bytes:
    result = subprocess.run(["git", *arguments], cwd=repo_root, capture_output=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise SealedBatchError(f"git {' '.join(arguments)} failed: {detail}")
    return bytes(result.stdout)


def _relative_to_repo(path: Path, repo_root: Path) -> str | None:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return None


def _local_imports(path: Path, scripts_root: Path) -> list[Path]:
    if path.suffix.lower() != ".py" or path.parent.resolve() != scripts_root.resolve():
        return []
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError) as error:
        raise SealedBatchError(f"failed to parse solver dependency {path}: {error}") from error
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module.split(".", 1)[0])
    return [scripts_root / f"{name}.py" for name in sorted(modules) if (scripts_root / f"{name}.py").is_file()]


def collect_dependency_files(entrypoints: Iterable[Path], scripts_root: Path) -> list[Path]:
    pending = [Path(item).resolve() for item in entrypoints]
    visited: set[Path] = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        if not path.is_file():
            raise SealedBatchError(f"solver dependency not found: {path}")
        visited.add(path)
        if path.suffix.casefold() == ".py":
            pending.extend(
                item for item in _local_imports(path, scripts_root) if item.resolve() not in visited
            )
    return sorted(visited, key=lambda item: str(item).casefold())


def git_lock_payload(repo_root: Path, dependencies: list[Path]) -> tuple[dict[str, Any], dict[str, Any]]:
    head = _git_output(repo_root, ["rev-parse", "HEAD"]).decode("utf-8", errors="replace").strip()
    relative = [item for path in dependencies if (item := _relative_to_repo(path, repo_root))]
    relevant_diff = _git_output(repo_root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", *relative])
    status = _git_output(repo_root, ["status", "--porcelain=v1", "-z"])
    worktree_diff = _git_output(repo_root, ["diff", "--binary", "--no-ext-diff", "HEAD"])
    return (
        {"head": head, "relevantDiffSha256": sha256_bytes(relevant_diff)},
        {
            "worktreeStatusSha256": sha256_bytes(status),
            "worktreeDiffSha256": sha256_bytes(worktree_diff),
        },
    )


def _identity_cache_path(cache_dir: Path, audio_path: Path) -> Path:
    normalized_path = os.path.normcase(str(audio_path.resolve())).encode("utf-8")
    return cache_dir / f"{sha256_bytes(normalized_path)}.json"


def _load_cached_identity(
    *,
    cache_path: Path,
    audio_path: Path,
    size: int,
    mtime_ns: int,
    helper_sha256: str,
    max_length_seconds: int,
) -> dict[str, Any] | None:
    if not cache_path.is_file():
        return None
    try:
        payload = load_json(cache_path)
    except SealedBatchError:
        return None
    if (
        int(payload.get("schemaVersion") or 0) != IDENTITY_CACHE_SCHEMA_VERSION
        or os.path.normcase(str(payload.get("filePath") or ""))
        != os.path.normcase(str(audio_path.resolve()))
        or int(payload.get("size") or -1) != size
        or int(payload.get("mtimeNs") or -1) != mtime_ns
        or str(payload.get("helperSha256") or "") != helper_sha256
        or int(payload.get("maxLengthSeconds") or 0) != max_length_seconds
        or len(str(payload.get("assetSha256") or "")) != 64
        or len(str(payload.get("pcmSha256") or "")) != 64
        or not str(payload.get("fingerprint") or "")
    ):
        return None
    return {
        "filePath": str(audio_path.resolve()),
        "size": size,
        "mtimeNs": mtime_ns,
        "assetSha256": str(payload["assetSha256"]),
        "pcmSha256": str(payload["pcmSha256"]),
        "fingerprint": str(payload["fingerprint"]),
        "duration": float(payload.get("duration") or 0.0),
    }


def _run_identity_chunk(
    *,
    node_executable: str,
    helper_path: Path,
    audio_paths: list[Path],
    max_length_seconds: int,
    repo_root: Path,
) -> dict[str, dict[str, Any]]:
    request = {
        "paths": [str(path.resolve()) for path in audio_paths],
        "maxLengthSeconds": int(max_length_seconds),
    }
    result = subprocess.run(
        [node_executable, str(helper_path.resolve())],
        cwd=repo_root,
        input=json.dumps(request, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise SealedBatchError(f"audio identity helper failed: {detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SealedBatchError(f"audio identity helper returned invalid JSON: {result.stdout[-2000:]}") from error
    rows = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) != len(audio_paths):
        raise SealedBatchError("audio identity helper returned an incomplete roster")
    resolved: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise SealedBatchError("audio identity helper returned an invalid row")
        file_path = str(row.get("filePath") or "").strip()
        pcm_sha256 = str(row.get("pcmSha256") or "").strip()
        fingerprint = str(row.get("fingerprint") or "").strip()
        if not file_path or len(pcm_sha256) != 64 or not fingerprint:
            raise SealedBatchError(f"audio identity helper failed for {file_path or '<unknown>'}")
        resolved[os.path.normcase(str(Path(file_path).resolve()))] = row
    return resolved


def run_identity_helper(
    *,
    node_executable: str,
    helper_path: Path,
    audio_paths: list[Path],
    max_length_seconds: int,
    repo_root: Path,
    cache_dir: Path | None = None,
    chunk_size: int = 16,
) -> dict[str, dict[str, Any]]:
    if chunk_size <= 0:
        raise SealedBatchError("audio identity chunk size must be positive")
    helper_sha256 = sha256_file(helper_path)
    resolved: dict[str, dict[str, Any]] = {}
    pending: list[Path] = []
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
    for audio_path in audio_paths:
        path = audio_path.resolve()
        try:
            stat = path.stat()
        except OSError as error:
            raise SealedBatchError(f"cannot stat audio for identity cache: {path}: {error}") from error
        cached = None
        if cache_dir is not None:
            cached = _load_cached_identity(
                cache_path=_identity_cache_path(cache_dir, path),
                audio_path=path,
                size=int(stat.st_size),
                mtime_ns=int(stat.st_mtime_ns),
                helper_sha256=helper_sha256,
                max_length_seconds=max_length_seconds,
            )
        key = os.path.normcase(str(path))
        if cached is not None:
            try:
                current_asset_sha256 = sha256_file(path)
            except OSError as error:
                raise SealedBatchError(f"cannot hash cached audio identity: {path}: {error}") from error
            if current_asset_sha256 == str(cached["assetSha256"]):
                resolved[key] = cached
            else:
                pending.append(path)
        else:
            pending.append(path)

    total_chunks = (len(pending) + chunk_size - 1) // chunk_size
    for chunk_index, start in enumerate(range(0, len(pending), chunk_size), start=1):
        chunk = pending[start : start + chunk_size]
        print(
            f"[sealed-identity] chunk {chunk_index}/{total_chunks}; "
            f"cached={len(audio_paths) - len(pending)}, pending={len(pending)}",
            file=sys.stderr,
            flush=True,
        )
        metadata: dict[str, dict[str, Any]] = {}
        for path in chunk:
            try:
                stat = path.stat()
                asset_sha256 = sha256_file(path)
            except OSError as error:
                raise SealedBatchError(f"cannot read audio for identity calculation: {path}: {error}") from error
            metadata[os.path.normcase(str(path))] = {
                "size": int(stat.st_size),
                "mtimeNs": int(stat.st_mtime_ns),
                "assetSha256": asset_sha256,
            }
        chunk_rows = _run_identity_chunk(
            node_executable=node_executable,
            helper_path=helper_path,
            audio_paths=chunk,
            max_length_seconds=max_length_seconds,
            repo_root=repo_root,
        )
        for path in chunk:
            key = os.path.normcase(str(path))
            identity = chunk_rows.get(key)
            before = metadata[key]
            try:
                after = path.stat()
            except OSError as error:
                raise SealedBatchError(f"cannot restat audio after identity calculation: {path}: {error}") from error
            if not identity:
                raise SealedBatchError(f"audio identity missing for {path}")
            if int(after.st_size) != before["size"] or int(after.st_mtime_ns) != before["mtimeNs"]:
                raise SealedBatchError(f"audio changed during identity calculation: {path}")
            enriched = {
                "filePath": str(path),
                **before,
                "pcmSha256": str(identity["pcmSha256"]),
                "fingerprint": str(identity["fingerprint"]),
                "duration": float(identity.get("duration") or 0.0),
            }
            resolved[key] = enriched
            if cache_dir is not None:
                write_json_atomic(
                    _identity_cache_path(cache_dir, path),
                    {
                        "schemaVersion": IDENTITY_CACHE_SCHEMA_VERSION,
                        "type": "rkb-audio-identity-cache-entry",
                        "helperSha256": helper_sha256,
                        "maxLengthSeconds": max_length_seconds,
                        **enriched,
                    },
                )
    return resolved


def build_audio_roster(
    *,
    audio_paths: list[Path],
    node_executable: str,
    helper_path: Path,
    max_length_seconds: int,
    repo_root: Path,
    include_source_path: bool = False,
    identity_cache_dir: Path | None = None,
    identity_chunk_size: int = 16,
) -> list[dict[str, Any]]:
    ordered = sorted((path.resolve() for path in audio_paths), key=lambda item: item.name.casefold())
    if not ordered or any(not path.is_file() for path in ordered):
        raise SealedBatchError("audio roster contains missing files")
    identities = run_identity_helper(
        node_executable=node_executable,
        helper_path=helper_path,
        audio_paths=ordered,
        max_length_seconds=max_length_seconds,
        repo_root=repo_root,
        cache_dir=identity_cache_dir,
        chunk_size=identity_chunk_size,
    )
    roster: list[dict[str, Any]] = []
    for path in ordered:
        identity = identities.get(os.path.normcase(str(path.resolve())))
        if not identity:
            raise SealedBatchError(f"audio identity missing for {path}")
        asset_sha256 = str(identity["assetSha256"])
        pcm_sha256 = str(identity["pcmSha256"])
        fingerprint = str(identity["fingerprint"])
        fingerprint_sha256 = sha256_bytes(fingerprint.encode("utf-8"))
        row = {
            "fileName": path.name,
            "normalizedFileName": normalize_name(path.name),
            "size": int(identity["size"]),
            "mtimeNs": int(identity["mtimeNs"]),
            "assetSha256": asset_sha256,
            "pcmSha256": pcm_sha256,
            "fingerprint": fingerprint,
            "fingerprintSha256": fingerprint_sha256,
            "fingerprintDurationSec": float(identity.get("duration") or 0.0),
            "familyId": f"chromaprint:{fingerprint_sha256}",
        }
        if include_source_path:
            row["sourcePath"] = str(path)
        roster.append(row)
    return roster


def audio_roster_hash(roster: list[dict[str, Any]]) -> str:
    stable = [
        {
            "fileName": item["fileName"],
            "size": item["size"],
            "assetSha256": item["assetSha256"],
            "pcmSha256": item["pcmSha256"],
            "fingerprintSha256": item["fingerprintSha256"],
        }
        for item in sorted(roster, key=lambda row: normalize_name(row.get("fileName")))
    ]
    return sha256_json(stable)


def truth_tracks(payload: dict[str, Any], path: Path) -> list[dict[str, Any]]:
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise SealedBatchError(f"truth contains no tracks: {path}")
    result = [item for item in tracks if isinstance(item, dict) and normalize_name(item.get("fileName"))]
    if len(result) != len(tracks):
        raise SealedBatchError(f"truth contains invalid tracks: {path}")
    return result


def assert_truth_audio_alignment(truth_path: Path, roster: list[dict[str, Any]]) -> None:
    truth = load_json(truth_path)
    truth_names = {normalize_name(item.get("fileName")) for item in truth_tracks(truth, truth_path)}
    audio_names = {normalize_name(item.get("fileName")) for item in roster}
    if truth_names != audio_names:
        missing = sorted(truth_names - audio_names)
        extra = sorted(audio_names - truth_names)
        raise SealedBatchError(f"truth/audio mismatch; missing={missing[:8]}, extra={extra[:8]}")


def batch_directories(batches_root: Path) -> list[Path]:
    if not batches_root.exists():
        return []
    return sorted(
        (
            item
            for item in batches_root.iterdir()
            if item.is_dir() and not item.name.startswith(".") and (item / MANIFEST_NAME).is_file()
        ),
        key=lambda item: item.name.casefold(),
    )


def _registry_baseline(
    batches_root: Path, baseline_path: Path | None
) -> dict[str, Any] | None:
    if baseline_path is not None:
        candidates = [baseline_path.resolve()] if baseline_path.exists() else []
    else:
        parent = batches_root.resolve().parent
        preferred = parent / "rkb-dataset-registry-baseline.json"
        candidates = [preferred] if preferred.is_file() else []
        candidates.extend(sorted(parent.glob("*baseline*.json"), key=lambda item: item.name.casefold()))
    payloads: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for path in candidates:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        payload = load_json(resolved)
        if payload.get("type") == "rkb-dataset-registry-baseline":
            payloads.append(payload)
        elif baseline_path is not None or resolved.name == "rkb-dataset-registry-baseline.json":
            raise SealedBatchError(f"invalid dataset baseline: {resolved}")
    if len(payloads) > 1:
        raise SealedBatchError("multiple dataset registry baselines found beside sealed batches")
    return payloads[0] if payloads else None


def _baseline_import_snapshots(baseline: dict[str, Any] | None) -> dict[str, dict[str, Any]] | None:
    if baseline is None:
        return None
    snapshots: dict[str, dict[str, Any]] = {}
    for item in baseline.get("batches") or []:
        if not isinstance(item, dict):
            raise SealedBatchError("dataset baseline contains an invalid batch snapshot")
        batch_id = str(item.get("batchId") or "")
        if not batch_id or batch_id in snapshots:
            raise SealedBatchError("dataset baseline contains duplicate or empty batchId")
        snapshots[batch_id] = item
    if not snapshots:
        raise SealedBatchError("dataset baseline contains no imported batch snapshots")
    return snapshots


def _validate_registry_batch_headers(
    batch_dir: Path, manifest: dict[str, Any], state: dict[str, Any]
) -> tuple[str, str, str]:
    batch_id = batch_dir.name
    manifest_sha256 = sha256_file(batch_dir / MANIFEST_NAME)
    state_sha256 = sha256_file(batch_dir / STATE_NAME)
    if str(manifest.get("batchId") or "") != batch_id:
        raise SealedBatchError(f"sealed manifest batchId mismatch: {batch_id}")
    if str(state.get("batchId") or "") != batch_id:
        raise SealedBatchError(f"sealed state batchId mismatch: {batch_id}")
    if str(state.get("manifestSha256") or "") != manifest_sha256:
        raise SealedBatchError(f"sealed state manifest hash mismatch: {batch_id}")
    return batch_id, manifest_sha256, state_sha256


def _validate_registry_truth_roster(
    batch_dir: Path, manifest: dict[str, Any], rows: list[dict[str, Any]]
) -> None:
    truth_path = batch_dir / TRUTH_NAME
    if not truth_path.is_file():
        raise SealedBatchError(f"sealed truth is missing: {batch_dir.name}")
    truth = load_json(truth_path)
    truth_rows = truth_tracks(truth, truth_path)
    manifest_truth = manifest.get("truth") if isinstance(manifest.get("truth"), dict) else {}
    audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
    if (
        str(manifest_truth.get("sha256") or "") != sha256_file(truth_path)
        or int(manifest_truth.get("trackCount") or -1) != len(truth_rows)
        or int(audio.get("trackCount") or -1) != len(rows)
        or len(truth_rows) != len(rows)
    ):
        raise SealedBatchError(f"sealed truth/roster hash or count mismatch: {batch_dir.name}")
    truth_names = [normalize_name(item.get("fileName")) for item in truth_rows]
    roster_names = [normalize_name(item.get("fileName")) for item in rows]
    if (
        sorted(truth_names) != sorted(roster_names)
        or len(set(truth_names)) != len(truth_names)
        or len(set(roster_names)) != len(roster_names)
    ):
        raise SealedBatchError(f"sealed truth/audio roster alignment mismatch: {batch_dir.name}")
    try:
        roster_hash = audio_roster_hash(rows)
    except (KeyError, TypeError, ValueError) as error:
        raise SealedBatchError(f"sealed audio roster is invalid: {batch_dir.name}") from error
    if roster_hash != str(audio.get("rosterHash") or ""):
        raise SealedBatchError(f"sealed audio roster hash mismatch: {batch_dir.name}")


def _validate_consumed_sealed_fresh(
    batch_dir: Path, manifest: dict[str, Any], state: dict[str, Any]
) -> None:
    batch_id = batch_dir.name
    solver_lock_path = batch_dir / SOLVER_LOCK_NAME
    benchmark_path = batch_dir / BENCHMARK_NAME
    finalization_path = batch_dir / FINALIZATION_NAME
    missing = [
        str(path)
        for path in (solver_lock_path, benchmark_path, finalization_path)
        if not path.is_file()
    ]
    if missing:
        raise SealedBatchError(f"consumed sealed-fresh proof is incomplete: {missing}")
    solver_lock = load_json(solver_lock_path)
    benchmark_sha256 = sha256_file(benchmark_path)
    finalization = load_json(finalization_path)
    lock_hash = str(solver_lock.get("lockHash") or "")
    locked = solver_lock.get("locked") if isinstance(solver_lock.get("locked"), dict) else None
    if not locked or sha256_json(locked) != lock_hash:
        raise SealedBatchError(f"sealed solver lockHash is internally inconsistent: {batch_id}")
    if (
        str(locked.get("batchId") or "") != batch_id
        or str(state.get("solverLockFileSha256") or "") != sha256_file(solver_lock_path)
        or str(state.get("solverLockHash") or "") != lock_hash
    ):
        raise SealedBatchError(f"sealed solver-lock file hash or batchId mismatch: {batch_id}")
    evaluation = state.get("evaluation") if isinstance(state.get("evaluation"), dict) else {}
    if (
        str(evaluation.get("status") or "") != "complete"
        or str(evaluation.get("benchmarkSha256") or "") != benchmark_sha256
    ):
        raise SealedBatchError(f"sealed evaluation benchmark hash/status mismatch: {batch_id}")
    state_finalization = (
        state.get("finalization") if isinstance(state.get("finalization"), dict) else {}
    )
    if str(state_finalization.get("sha256") or "") != sha256_file(finalization_path):
        raise SealedBatchError(f"sealed finalization file hash mismatch: {batch_id}")
    if (
        str(finalization.get("batchId") or "") != batch_id
        or str(finalization.get("solverLockHash") or "") != lock_hash
        or str(finalization.get("benchmarkSha256") or "") != benchmark_sha256
        or str(finalization.get("evaluationStatus") or "") != "complete"
        or str(finalization.get("decision") or "")
        != str(state_finalization.get("decision") or "")
    ):
        raise SealedBatchError(f"sealed finalization proof mismatch: {batch_id}")
    history = state.get("history") if isinstance(state.get("history"), list) else []
    transitions = [
        (item.get("from"), str(item.get("to") or ""))
        for item in history
        if isinstance(item, dict)
    ]
    expected = [
        (None, "fresh"),
        ("fresh", "evaluating"),
        ("evaluating", "exposed"),
        ("exposed", "consumed"),
    ]
    if transitions != expected:
        raise SealedBatchError(f"sealed lifecycle history is incomplete or invalid: {batch_id}")


def _build_registry_payload_unmapped(
    batches_root: Path, baseline_path: Path | None = None
) -> dict[str, Any]:
    tracks: list[dict[str, Any]] = []
    batches: list[dict[str, Any]] = []
    baseline_imports = _baseline_import_snapshots(_registry_baseline(batches_root, baseline_path))
    seen_imports: set[str] = set()
    for batch_dir in batch_directories(batches_root):
        manifest = load_json(batch_dir / MANIFEST_NAME)
        state = load_json(batch_dir / STATE_NAME)
        batch_id, manifest_sha256, state_sha256 = _validate_registry_batch_headers(
            batch_dir, manifest, state
        )
        status = str(state.get("status") or "unknown")
        rows = [item for item in manifest.get("audioRoster") or [] if isinstance(item, dict)]
        _validate_registry_truth_roster(batch_dir, manifest, rows)
        origin = str((manifest.get("origin") or {}).get("kind") or "")
        if origin == "import-consumed":
            if status != "consumed":
                raise SealedBatchError(f"imported registry batch is not consumed: {batch_id}")
            seen_imports.add(batch_id)
            if baseline_imports is not None:
                snapshot = baseline_imports.get(batch_id)
                if not snapshot:
                    raise SealedBatchError(f"consumed import is outside dataset baseline: {batch_id}")
                if (
                    str(snapshot.get("manifestSha256") or "") != manifest_sha256
                    or str(snapshot.get("stateSha256") or "") != state_sha256
                    or int(snapshot.get("trackCount") or -1) != len(rows)
                ):
                    raise SealedBatchError(f"baseline imported batch snapshot mismatch: {batch_id}")
        elif origin in {"sealed-fresh", "sealed-fresh-reviewed"}:
            if status not in {"fresh", "evaluating", "exposed", "consumed"}:
                raise SealedBatchError(f"sealed-fresh registry batch has invalid status: {batch_id}")
            if status == "consumed":
                _validate_consumed_sealed_fresh(batch_dir, manifest, state)
        elif origin == "reviewed-development":
            if status != "consumed":
                raise SealedBatchError(f"reviewed development batch is not consumed: {batch_id}")
            from rkb_reviewed_development import validate_consumed_reviewed_development

            validate_consumed_reviewed_development(batch_dir, manifest, state)
        else:
            raise SealedBatchError(f"unsupported registry batch origin: {batch_id}:{origin}")
        audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
        sealed_source_root = ""
        if origin in {"sealed-fresh", "sealed-fresh-reviewed", "reviewed-development"}:
            root_key = "archiveRoot" if status == "consumed" else "stagingRoot"
            sealed_source_root = str(audio.get(root_key) or "")
            if not sealed_source_root:
                raise SealedBatchError(f"sealed registry source root is missing: {batch_id}")
        batches.append(
            {
                "batchId": batch_id,
                "origin": origin,
                "status": status,
                "decision": str((state.get("finalization") or {}).get("decision") or ""),
                "trackCount": len(rows),
                "manifestSha256": manifest_sha256,
                "stateSha256": state_sha256,
                "audioRosterHash": str((manifest.get("audio") or {}).get("rosterHash") or ""),
            }
        )
        for item in rows:
            tracks.append(
                {
                    "fileName": str(item.get("fileName") or ""),
                    "familyId": str(item.get("familyId") or ""),
                    "batchId": batch_id,
                    "batchStatus": status,
                    "assetSha256": str(item.get("assetSha256") or ""),
                    "pcmSha256": str(item.get("pcmSha256") or ""),
                    "fingerprint": str(item.get("fingerprint") or ""),
                    "fingerprintSha256": str(item.get("fingerprintSha256") or ""),
                    "sourcePath": (
                        str(Path(sealed_source_root) / str(item.get("fileName") or ""))
                        if sealed_source_root
                        else str(item.get("sourcePath") or "")
                    ),
                }
            )
    if baseline_imports is not None and seen_imports != set(baseline_imports):
        missing = sorted(set(baseline_imports) - seen_imports)
        raise SealedBatchError(f"dataset baseline imported batches are missing: {missing}")
    tracks.sort(key=lambda item: (str(item["batchId"]), normalize_name(item["fileName"])))
    batches.sort(key=lambda item: str(item["batchId"]))
    identity_counts = {
        key: len({str(row.get(key) or "") for row in tracks if str(row.get(key) or "")})
        for key in ("assetSha256", "pcmSha256", "fingerprintSha256")
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "type": "rkb-dataset-registry",
        "generatedAt": utc_now(),
        "source": "immutable sealed/consumed batch manifests",
        "batchesRoot": str(batches_root.resolve()),
        "batchCount": len(batches),
        "trackCount": len(tracks),
        "uniqueIdentityCounts": identity_counts,
        "identityPolicy": {
            "familyId": "chromaprint fingerprint sha256",
            "exactAsset": "raw file sha256",
            "exactPcm": "native normalized PCM sha256",
            "identityFailurePolicy": "hard-error",
        },
        "batches": batches,
        "tracks": tracks,
    }


def build_registry_payload(
    batches_root: Path, baseline_path: Path | None = None, root_remap: dict[str, Any] | None = None
) -> dict[str, Any]:
    source_registry = _build_registry_payload_unmapped(batches_root, baseline_path)
    if root_remap is None:
        return source_registry
    from rkb_dataset_relocation import apply_root_remap

    return apply_root_remap(source_registry, root_remap)


def rebuild_registry(
    batches_root: Path,
    registry_path: Path,
    baseline_path: Path | None = None,
    root_remap_path: Path | None = None,
    use_auto_root_remap: bool = True,
) -> dict[str, Any]:
    from rkb_dataset_relocation import resolve_root_remap_for_registry, verify_registry_source_assets

    remap = None
    if use_auto_root_remap:
        remap = resolve_root_remap_for_registry(
            registry_path=registry_path,
            batches_root=batches_root,
            root_remap_path=root_remap_path,
        )
    payload = build_registry_payload(batches_root, baseline_path, root_remap=remap)
    if remap is not None:
        verify_registry_source_assets(payload)
    with exclusive_lock(
        registry_path.with_name(f".{registry_path.name}.lock"),
        {"pid": os.getpid(), "startedAt": utc_now(), "operation": "rebuild-registry"},
    ):
        write_json_atomic(registry_path, payload)
    return payload


def registry_identity_index(registry: dict[str, Any]) -> dict[str, dict[str, list[dict[str, str]]]]:
    index: dict[str, dict[str, list[dict[str, str]]]] = {
        "assetSha256": {},
        "pcmSha256": {},
        "fingerprintSha256": {},
    }
    for row in registry.get("tracks") or []:
        if not isinstance(row, dict):
            continue
        match = {"batchId": str(row.get("batchId") or ""), "fileName": str(row.get("fileName") or "")}
        for key in index:
            value = str(row.get(key) or "")
            if value:
                index[key].setdefault(value, []).append(match)
    return index


def transition_state(state: dict[str, Any], next_status: str, event: str) -> dict[str, Any]:
    current = str(state.get("status") or "")
    allowed = {
        "fresh": {"evaluating"},
        "evaluating": {"exposed"},
        "exposed": {"consumed"},
        "consumed": set(),
    }
    if next_status not in allowed.get(current, set()):
        raise SealedBatchError(f"invalid sealed batch transition: {current} -> {next_status}")
    history = list(state.get("history") or [])
    history.append({"at": utc_now(), "from": current, "to": next_status, "event": event})
    return {**state, "status": next_status, "updatedAt": utc_now(), "history": history}


def resolve_batch_dir(batches_root: Path, requested: str, allowed_statuses: set[str]) -> Path:
    if requested and requested != "latest":
        batch_dir = batches_root / requested
        if not (batch_dir / MANIFEST_NAME).is_file():
            raise SealedBatchError(f"sealed batch not found: {requested}")
        state = load_json(batch_dir / STATE_NAME)
        if str(state.get("status") or "") not in allowed_statuses:
            raise SealedBatchError(
                f"batch {requested} status is {state.get('status')}, expected one of {sorted(allowed_statuses)}"
            )
        return batch_dir
    candidates: list[tuple[str, Path]] = []
    for batch_dir in batch_directories(batches_root):
        state = load_json(batch_dir / STATE_NAME)
        if str(state.get("status") or "") in allowed_statuses:
            candidates.append((str(state.get("createdAt") or ""), batch_dir))
    if not candidates:
        raise SealedBatchError(f"no sealed batch found with status in {sorted(allowed_statuses)}")
    return max(candidates, key=lambda item: (item[0], item[1].name))[1]


def build_solver_lock(
    *,
    manifest: dict[str, Any],
    cli_payload: dict[str, Any],
    checkpoint_path: Path,
    dependency_entrypoints: list[Path],
    repo_root: Path,
    scripts_root: Path,
) -> dict[str, Any]:
    dependencies = collect_dependency_files(dependency_entrypoints, scripts_root)
    git_locked, git_audit = git_lock_payload(repo_root, dependencies)
    locked = {
        "schemaVersion": SCHEMA_VERSION,
        "batchId": str(manifest.get("batchId") or ""),
        "git": git_locked,
        "solver": {
            "entrypoints": [str(item.resolve()) for item in dependency_entrypoints],
            "dependencies": [path_signature(path) for path in dependencies],
        },
        "checkpoint": path_signature(checkpoint_path),
        "cli": cli_payload,
        "truth": manifest.get("truth"),
        "audio": manifest.get("audio"),
        "identityTool": manifest.get("identityTool"),
        "acceptancePolicy": manifest.get("acceptancePolicy"),
        "runtime": runtime_lock_payload(
            cli_payload,
            manifest.get("identityTool")
            if isinstance(manifest.get("identityTool"), dict)
            else {},
        ),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "type": "rkb-sealed-solver-lock",
        "capturedAt": utc_now(),
        "lockHash": sha256_json(locked),
        "locked": locked,
        "audit": {"git": git_audit},
    }


def verify_roster_from_manifest(manifest: dict[str, Any], audio_root: Path, repo_root: Path) -> list[dict[str, Any]]:
    expected = [item for item in manifest.get("audioRoster") or [] if isinstance(item, dict)]
    paths = [audio_root / str(item.get("fileName") or "") for item in expected]
    identity = manifest.get("identityTool") if isinstance(manifest.get("identityTool"), dict) else {}
    helper_path = Path(str(identity.get("helperPath") or ""))
    expected_helper_sha256 = str(identity.get("helperSha256") or "")
    if (
        not helper_path.is_file()
        or len(expected_helper_sha256) != 64
        or sha256_file(helper_path) != expected_helper_sha256
    ):
        raise SealedBatchError("sealed audio identity helper hash mismatch")
    current = build_audio_roster(
        audio_paths=paths,
        node_executable=str(identity.get("node") or ""),
        helper_path=helper_path,
        max_length_seconds=int(identity.get("maxLengthSeconds") or 120),
        repo_root=repo_root,
        identity_cache_dir=(
            Path(str(identity.get("cacheDir") or ""))
            if str(identity.get("cacheDir") or "").strip()
            else None
        ),
        identity_chunk_size=int(identity.get("chunkSize") or 16),
    )
    if audio_roster_hash(current) != str((manifest.get("audio") or {}).get("rosterHash") or ""):
        raise SealedBatchError(f"sealed audio roster hash mismatch: {audio_root}")
    return current


def verify_manifest_and_lock(
    *, batch_dir: Path, repo_root: Path, scripts_root: Path
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    manifest_path = batch_dir / MANIFEST_NAME
    state_path = batch_dir / STATE_NAME
    lock_path = batch_dir / SOLVER_LOCK_NAME
    manifest = load_json(manifest_path)
    state = load_json(state_path)
    stored_lock = load_json(lock_path)
    if sha256_file(manifest_path) != str(state.get("manifestSha256") or ""):
        raise SealedBatchError("immutable batch manifest hash mismatch")
    if sha256_file(lock_path) != str(state.get("solverLockFileSha256") or ""):
        raise SealedBatchError("immutable solver lock file hash mismatch")
    truth_path = Path(str((manifest.get("truth") or {}).get("path") or ""))
    if not truth_path.is_file() or sha256_file(truth_path) != str((manifest.get("truth") or {}).get("sha256") or ""):
        raise SealedBatchError("sealed truth hash mismatch")
    audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
    staging_root = Path(str(audio.get("stagingRoot") or ""))
    archive_root = Path(str(audio.get("archiveRoot") or ""))
    audio_root = staging_root if staging_root.is_dir() else archive_root
    roster = verify_roster_from_manifest(manifest, audio_root, repo_root)
    assert_truth_audio_alignment(truth_path, roster)
    locked = stored_lock.get("locked") if isinstance(stored_lock.get("locked"), dict) else {}
    solver = locked.get("solver") if isinstance(locked.get("solver"), dict) else {}
    current_lock = build_solver_lock(
        manifest=manifest,
        cli_payload=locked.get("cli") if isinstance(locked.get("cli"), dict) else {},
        checkpoint_path=Path(str((locked.get("checkpoint") or {}).get("path") or "")),
        dependency_entrypoints=[Path(item) for item in solver.get("entrypoints") or []],
        repo_root=repo_root,
        scripts_root=scripts_root,
    )
    expected_hash = str(stored_lock.get("lockHash") or "")
    if current_lock.get("lockHash") != expected_hash:
        raise SealedBatchError(
            f"solver lock changed: expected {expected_hash}, current {current_lock.get('lockHash')}"
        )
    evaluation_hash = str((state.get("evaluation") or {}).get("lockHash") or expected_hash)
    if evaluation_hash != expected_hash:
        raise SealedBatchError("state evaluation lockHash does not match immutable solver lock")
    return manifest, state, stored_lock
