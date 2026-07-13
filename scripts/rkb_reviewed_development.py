from pathlib import Path
from typing import Any

from rkb_sealed_batch_common import FINALIZATION_NAME, SealedBatchError, load_json, sha256_file


def validate_consumed_reviewed_development(
    batch_dir: Path, manifest: dict[str, Any], state: dict[str, Any]
) -> None:
    batch_id = batch_dir.name
    finalization_path = batch_dir / FINALIZATION_NAME
    if not finalization_path.is_file():
        raise SealedBatchError(f"reviewed development finalization is missing: {batch_id}")
    origin = manifest.get("origin") if isinstance(manifest.get("origin"), dict) else {}
    report = origin.get("preReviewReport") if isinstance(origin.get("preReviewReport"), dict) else {}
    report_path = Path(str(report.get("path") or ""))
    report_sha256 = str(report.get("sha256") or "")
    if not report_path.is_file() or len(report_sha256) != 64 or sha256_file(report_path) != report_sha256:
        raise SealedBatchError(f"reviewed development pre-review report proof is invalid: {batch_id}")
    evaluation = state.get("evaluation") if isinstance(state.get("evaluation"), dict) else {}
    if (
        str(evaluation.get("status") or "") != "reviewed-development"
        or str(evaluation.get("preReviewReportSha256") or "") != report_sha256
        or bool(evaluation.get("freshProofEligible"))
    ):
        raise SealedBatchError(f"reviewed development state is invalid: {batch_id}")
    finalization = load_json(finalization_path)
    state_finalization = (
        state.get("finalization") if isinstance(state.get("finalization"), dict) else {}
    )
    if (
        str(state_finalization.get("sha256") or "") != sha256_file(finalization_path)
        or str(state_finalization.get("decision") or "") != "consume"
        or str(finalization.get("batchId") or "") != batch_id
        or str(finalization.get("decision") or "") != "consume"
        or str(finalization.get("evaluationStatus") or "") != "reviewed-development"
        or str(finalization.get("preReviewReportSha256") or "") != report_sha256
        or bool(finalization.get("freshProofEligible"))
    ):
        raise SealedBatchError(f"reviewed development finalization proof mismatch: {batch_id}")
    history = state.get("history") if isinstance(state.get("history"), list) else []
    transitions = [
        (item.get("from"), str(item.get("to") or ""))
        for item in history
        if isinstance(item, dict)
    ]
    if transitions != [(None, "consumed")]:
        raise SealedBatchError(f"reviewed development lifecycle is invalid: {batch_id}")
