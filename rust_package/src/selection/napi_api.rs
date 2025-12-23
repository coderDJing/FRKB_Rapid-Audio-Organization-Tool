use crate::selection::feature_store::{self, SongFeaturesPatch};
use crate::selection::label_store::{self, SelectionLabel};
use crate::selection::manifest::{read_manifest, write_manifest, SelectionManifest};
use crate::selection::model::{self, SelectionErrorCode};
use crate::selection::openl3;
use crate::selection::path_index_store;
use crate::selection::paths::{
  library_root_from_feature_store_path, normalize_feature_store_path, normalize_label_store_path,
  normalize_path_index_store_path,
  selection_gbdt_model_path, selection_manifest_path, selection_model_dir,
};
use bytemuck::cast_slice;
use napi::bindgen_prelude::*;
use napi::tokio;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[napi(object)]
pub struct SelectionFailed {
  pub error_code: String,
  pub message: Option<String>,
}

#[napi(object)]
pub struct TrainSelectionGbdtResult {
  pub status: String,
  pub model_revision: Option<i64>,
  pub model_path: Option<String>,
  pub failed: Option<SelectionFailed>,
}

#[napi(object)]
pub struct PredictSelectionItem {
  pub id: String,
  pub score: f64,
}

#[napi(object)]
pub struct PredictSelectionCandidatesResult {
  pub status: String,
  pub model_revision: Option<i64>,
  pub items: Option<Vec<PredictSelectionItem>>,
  pub failed: Option<SelectionFailed>,
}

#[napi(object)]
pub struct SelectionFeatureStatusItem {
  pub song_id: String,
  pub has_features: bool,
}

#[napi(object)]
pub struct UpsertSongFeaturesInput {
  pub song_id: String,
  pub file_hash: String,
  pub model_version: String,
  pub openl3_vector: Option<Buffer>,
  pub chromaprint_fingerprint: Option<String>,
  pub rms_mean: Option<f64>,
  pub hpcp: Option<Buffer>,
  pub bpm: Option<f64>,
  pub key: Option<String>,
  pub duration_sec: Option<f64>,
  pub bitrate_kbps: Option<f64>,
}

#[napi(object)]
pub struct SetSelectionLabelsResult {
  pub total: i32,
  pub changed: i32,
  pub sample_change_count: i64,
  pub sample_change_delta: i32,
}

#[napi(object)]
pub struct SelectionLabelSnapshot {
  pub positive_ids: Vec<String>,
  pub negative_ids: Vec<String>,
  pub sample_change_count: i64,
}

#[napi(object)]
pub struct SelectionPathIndexEntry {
  pub path_key: String,
  pub file_path: String,
  pub size: i64,
  pub mtime_ms: i64,
  pub song_id: String,
  pub file_hash: String,
  pub updated_at: i64,
  pub last_seen_at: i64,
}

#[napi(object)]
pub struct UpsertSelectionPathIndexEntry {
  pub path_key: String,
  pub file_path: String,
  pub size: i64,
  pub mtime_ms: i64,
  pub song_id: String,
  pub file_hash: String,
}

#[napi(object)]
pub struct SelectionPathIndexGcOptions {
  pub ttl_days: Option<i32>,
  pub max_rows: Option<i32>,
  pub delete_limit: Option<i32>,
  pub min_interval_ms: Option<i64>,
}

#[napi(object)]
pub struct SelectionPathIndexGcResult {
  pub skipped: bool,
  pub before: i64,
  pub after: i64,
  pub deleted_old: i64,
  pub deleted_overflow: i64,
  pub last_gc_at: i64,
}

#[napi]
pub fn upsert_song_features(
  feature_store_path: String,
  items: Vec<UpsertSongFeaturesInput>,
) -> napi::Result<i32> {
  let db_path = normalize_feature_store_path(&feature_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("featureStorePath 不能为空"));
  }
  let mut conn = feature_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let patches: Vec<SongFeaturesPatch> = items
    .into_iter()
    .map(|it| SongFeaturesPatch {
      song_id: it.song_id,
      file_hash: it.file_hash,
      model_version: it.model_version,
      openl3_vector: it.openl3_vector.map(|b| b.to_vec()),
      chromaprint_fingerprint: it.chromaprint_fingerprint,
      rms_mean: it.rms_mean,
      hpcp: it.hpcp.map(|b| b.to_vec()),
      bpm: it.bpm,
      key: it.key,
      duration_sec: it.duration_sec,
      bitrate_kbps: it.bitrate_kbps,
    })
    .collect();

  let affected = feature_store::upsert_song_features(&mut conn, &patches)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  Ok(affected as i32)
}

#[napi]
pub async fn extract_open_l3_embedding(
  file_path: String,
  max_seconds: Option<f64>,
  max_windows: Option<i32>,
) -> napi::Result<Buffer> {
  let max_windows_usize: Option<usize> = max_windows.and_then(|v| if v > 0 { Some(v as usize) } else { None });
  match tokio::task::spawn_blocking(move || openl3::extract_openl3_embedding(&file_path, max_seconds, max_windows_usize)).await
  {
    Ok(Ok(vec)) => Ok(Buffer::from(cast_slice(&vec).to_vec())),
    Ok(Err(e)) => Err(napi::Error::from_reason(e)),
    Err(e) => Err(napi::Error::from_reason(format!("内部 OpenL3 任务失败: {}", e))),
  }
}

#[napi]
pub fn set_selection_labels(
  label_store_path: String,
  song_ids: Vec<String>,
  label: String,
) -> napi::Result<SetSelectionLabelsResult> {
  let db_path = normalize_label_store_path(&label_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("labelStorePath 不能为空"));
  }
  let Some(label) = SelectionLabel::parse(&label) else {
    return Err(napi::Error::from_reason("label 必须为 liked/disliked/neutral"));
  };

  let mut conn =
    label_store::open_and_migrate(&db_path).map_err(|e| napi::Error::from_reason(e))?;

  let (total, delta, sample_change_count) =
    label_store::set_labels_bulk(&mut conn, song_ids, label)
      .map_err(|e| napi::Error::from_reason(e))?;

  Ok(SetSelectionLabelsResult {
    total,
    changed: delta,
    sample_change_count,
    sample_change_delta: delta,
  })
}

#[napi]
pub fn get_selection_label_snapshot(label_store_path: String) -> napi::Result<SelectionLabelSnapshot> {
  let db_path = normalize_label_store_path(&label_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("labelStorePath 不能为空"));
  }
  let conn = label_store::open_and_migrate(&db_path).map_err(|e| napi::Error::from_reason(e))?;
  let sample_change_count =
    label_store::get_sample_change_count(&conn).map_err(|e| napi::Error::from_reason(e))?;
  let (positive_ids, negative_ids) =
    label_store::get_label_snapshot(&conn).map_err(|e| napi::Error::from_reason(e))?;
  Ok(SelectionLabelSnapshot {
    positive_ids,
    negative_ids,
    sample_change_count,
  })
}

#[napi]
pub fn reset_selection_sample_change_count(label_store_path: String) -> napi::Result<i64> {
  let db_path = normalize_label_store_path(&label_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("labelStorePath 不能为空"));
  }
  let conn = label_store::open_and_migrate(&db_path).map_err(|e| napi::Error::from_reason(e))?;
  label_store::set_sample_change_count(&conn, 0).map_err(|e| napi::Error::from_reason(e))?;
  Ok(0)
}

#[napi]
pub fn reset_selection_labels(label_store_path: String) -> napi::Result<bool> {
  let db_path = normalize_label_store_path(&label_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("labelStorePath 不能为空"));
  }
  let mut conn =
    label_store::open_and_migrate(&db_path).map_err(|e| napi::Error::from_reason(e))?;
  label_store::reset_all(&mut conn).map_err(|e| napi::Error::from_reason(e))?;
  Ok(true)
}

#[napi]
pub fn get_selection_feature_status(
  feature_store_path: String,
  song_ids: Vec<String>,
) -> napi::Result<Vec<SelectionFeatureStatusItem>> {
  let db_path = normalize_feature_store_path(&feature_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("featureStorePath 不能为空"));
  }

  let conn = feature_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let mut ids = song_ids;
  ids.sort();
  ids.dedup();

  let map = feature_store::get_song_feature_status_map(&conn, &ids)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  Ok(
    ids
      .into_iter()
      .map(|song_id| SelectionFeatureStatusItem {
        has_features: *map.get(&song_id).unwrap_or(&false),
        song_id,
      })
      .collect(),
  )
}

#[napi]
pub fn get_selection_path_index_entries(
  path_index_store_path: String,
  path_keys: Vec<String>,
) -> napi::Result<Vec<SelectionPathIndexEntry>> {
  let db_path = normalize_path_index_store_path(&path_index_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("pathIndexStorePath 不能为空"));
  }

  let conn = path_index_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let mut keys: Vec<String> = path_keys
    .into_iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
  keys.sort();
  keys.dedup();

  const SQLITE_VAR_LIMIT: usize = 900;
  let mut out: Vec<SelectionPathIndexEntry> = Vec::new();
  for chunk in keys.chunks(SQLITE_VAR_LIMIT) {
    let rows = path_index_store::get_rows_by_path_keys(&conn, chunk)
      .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
    for r in rows {
      out.push(SelectionPathIndexEntry {
        path_key: r.path_key,
        file_path: r.file_path,
        size: r.size,
        mtime_ms: r.mtime_ms,
        song_id: r.song_id,
        file_hash: r.file_hash,
        updated_at: r.updated_at,
        last_seen_at: r.last_seen_at,
      });
    }
  }
  Ok(out)
}

#[napi]
pub fn upsert_selection_path_index_entries(
  path_index_store_path: String,
  items: Vec<UpsertSelectionPathIndexEntry>,
) -> napi::Result<i64> {
  let db_path = normalize_path_index_store_path(&path_index_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("pathIndexStorePath 不能为空"));
  }

  let mut conn = path_index_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let now_ms = path_index_store::now_millis_i64();
  let rows: Vec<path_index_store::PathIndexRow> = items
    .into_iter()
    .map(|it| path_index_store::PathIndexRow {
      path_key: it.path_key,
      file_path: it.file_path,
      size: it.size,
      mtime_ms: it.mtime_ms,
      song_id: it.song_id,
      file_hash: it.file_hash,
      updated_at: now_ms,
      last_seen_at: now_ms,
    })
    .collect();

  let affected = path_index_store::upsert_rows(&mut conn, &rows)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  Ok(affected)
}

#[napi]
pub fn touch_selection_path_index_entries(
  path_index_store_path: String,
  path_keys: Vec<String>,
) -> napi::Result<i64> {
  let db_path = normalize_path_index_store_path(&path_index_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("pathIndexStorePath 不能为空"));
  }

  let mut conn = path_index_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let mut keys: Vec<String> = path_keys
    .into_iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
  keys.sort();
  keys.dedup();

  let now_ms = path_index_store::now_millis_i64();
  let affected = path_index_store::touch_by_path_keys(&mut conn, &keys, now_ms)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  Ok(affected)
}

#[napi]
pub fn delete_selection_path_index_entries(
  path_index_store_path: String,
  path_keys: Vec<String>,
) -> napi::Result<i64> {
  let db_path = normalize_path_index_store_path(&path_index_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("pathIndexStorePath 不能为空"));
  }

  let mut conn = path_index_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let mut keys: Vec<String> = path_keys
    .into_iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
  keys.sort();
  keys.dedup();

  let affected = path_index_store::delete_by_path_keys(&mut conn, &keys)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  Ok(affected)
}

#[napi]
pub fn gc_selection_path_index(
  path_index_store_path: String,
  options: Option<SelectionPathIndexGcOptions>,
) -> napi::Result<SelectionPathIndexGcResult> {
  let db_path = normalize_path_index_store_path(&path_index_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("pathIndexStorePath 不能为空"));
  }

  let mut conn = path_index_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  let now_ms = path_index_store::now_millis_i64();
  let ttl_days = options
    .as_ref()
    .and_then(|o| o.ttl_days)
    .unwrap_or(30)
    .max(1) as i64;
  let ttl_ms = ttl_days * 24 * 60 * 60 * 1000;
  let max_rows = options
    .as_ref()
    .and_then(|o| o.max_rows)
    .unwrap_or(200_000)
    .max(10_000) as i64;
  let delete_limit = options
    .as_ref()
    .and_then(|o| o.delete_limit)
    .unwrap_or(5_000)
    .max(100) as i64;
  let min_interval_ms = options
    .as_ref()
    .and_then(|o| o.min_interval_ms)
    .unwrap_or(24 * 60 * 60 * 1000);

  let res = path_index_store::gc(&mut conn, now_ms, min_interval_ms, ttl_ms, max_rows, delete_limit)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;

  Ok(SelectionPathIndexGcResult {
    skipped: res.skipped,
    before: res.before,
    after: res.after,
    deleted_old: res.deleted_old,
    deleted_overflow: res.deleted_overflow,
    last_gc_at: res.last_gc_at,
  })
}

#[napi]
pub fn get_selection_label(label_store_path: String, song_id: String) -> napi::Result<String> {
  let db_path = normalize_label_store_path(&label_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("labelStorePath 不能为空"));
  }
  let conn = label_store::open_and_migrate(&db_path).map_err(|e| napi::Error::from_reason(e))?;
  let label = label_store::get_label_for_song_id(&conn, &song_id)
    .map_err(|e| napi::Error::from_reason(e))?;
  Ok(label.as_str().to_string())
}

#[napi]
pub fn bump_selection_sample_change_count(
  label_store_path: String,
  delta: i64,
) -> napi::Result<i64> {
  let db_path = normalize_label_store_path(&label_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("labelStorePath 不能为空"));
  }
  let mut conn =
    label_store::open_and_migrate(&db_path).map_err(|e| napi::Error::from_reason(e))?;
  label_store::bump_sample_change_count(&mut conn, delta)
    .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn delete_selection_prediction_cache(
  feature_store_path: String,
  song_ids: Vec<String>,
) -> napi::Result<i32> {
  let db_path = normalize_feature_store_path(&feature_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("featureStorePath 不能为空"));
  }
  let conn = feature_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  let affected = feature_store::delete_prediction_cache_for_song_ids(&conn, &song_ids)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  Ok(affected as i32)
}

#[napi]
pub fn clear_selection_prediction_cache(feature_store_path: String) -> napi::Result<i32> {
  let db_path = normalize_feature_store_path(&feature_store_path);
  if db_path.as_os_str().is_empty() {
    return Err(napi::Error::from_reason("featureStorePath 不能为空"));
  }
  let conn = feature_store::open_and_migrate(&db_path)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  let affected = feature_store::clear_prediction_cache(&conn)
    .map_err(|e| napi::Error::from_reason(format!("db_error: {}", e)))?;
  Ok(affected as i32)
}

#[napi]
pub fn train_selection_gbdt(
  positive_ids: Vec<String>,
  negative_ids: Vec<String>,
  feature_store_path: String,
) -> napi::Result<TrainSelectionGbdtResult> {
  let db_path = normalize_feature_store_path(&feature_store_path);
  if db_path.as_os_str().is_empty() {
    return Ok(TrainSelectionGbdtResult {
      status: "failed".to_string(),
      model_revision: None,
      model_path: None,
      failed: Some(SelectionFailed {
        error_code: SelectionErrorCode::InternalError.as_str().to_string(),
        message: Some("featureStorePath 不能为空".to_string()),
      }),
    });
  }

  let Some(library_root) = library_root_from_feature_store_path(&db_path) else {
    return Ok(TrainSelectionGbdtResult {
      status: "failed".to_string(),
      model_revision: None,
      model_path: None,
      failed: Some(SelectionFailed {
        error_code: SelectionErrorCode::InternalError.as_str().to_string(),
        message: Some("无法解析库根目录".to_string()),
      }),
    });
  };

  let model_dir = selection_model_dir(&library_root);
  let manifest_path = selection_manifest_path(&library_root);
  let model_path = selection_gbdt_model_path(&library_root);

  if let Err(e) = fs::create_dir_all(&model_dir) {
    return Ok(TrainSelectionGbdtResult {
      status: "failed".to_string(),
      model_revision: None,
      model_path: None,
      failed: Some(SelectionFailed {
        error_code: SelectionErrorCode::InternalError.as_str().to_string(),
        message: Some(format!("创建 models/selection 失败: {}", e)),
      }),
    });
  }

  let old_revision = match read_manifest(&manifest_path) {
    Ok(Some(m)) => m.model_revision,
    Ok(None) => 0,
    Err(e) => {
      return Ok(TrainSelectionGbdtResult {
        status: "failed".to_string(),
        model_revision: None,
        model_path: None,
        failed: Some(SelectionFailed {
          error_code: SelectionErrorCode::ModelLoadFailed.as_str().to_string(),
          message: Some(e),
        }),
      });
    }
  };

  let new_revision = old_revision + 1;

  let conn = match feature_store::open_and_migrate(&db_path) {
    Ok(c) => c,
    Err(e) => {
      return Ok(TrainSelectionGbdtResult {
        status: "failed".to_string(),
        model_revision: None,
        model_path: None,
        failed: Some(SelectionFailed {
          error_code: SelectionErrorCode::DbError.as_str().to_string(),
          message: Some(e),
        }),
      });
    }
  };

  let mut all_ids: Vec<String> = Vec::with_capacity(positive_ids.len() + negative_ids.len());
  all_ids.extend(positive_ids.iter().cloned());
  all_ids.extend(negative_ids.iter().cloned());
  all_ids.sort();
  all_ids.dedup();

  let features_map = match feature_store::get_song_features_map(&conn, &all_ids) {
    Ok(m) => m,
    Err(e) => {
      return Ok(TrainSelectionGbdtResult {
        status: "failed".to_string(),
        model_revision: None,
        model_path: None,
        failed: Some(SelectionFailed {
          error_code: SelectionErrorCode::DbError.as_str().to_string(),
          message: Some(e),
        }),
      });
    }
  };

  let trained_at_ms = now_millis_string();

  let outcome = match model::train_gbdt_model(
    positive_ids,
    negative_ids,
    new_revision,
    &features_map,
    trained_at_ms.clone(),
  ) {
    Ok(o) => o,
    Err(e) => {
      return Ok(TrainSelectionGbdtResult {
        status: "failed".to_string(),
        model_revision: None,
        model_path: None,
        failed: Some(SelectionFailed {
          error_code: e.error_code.as_str().to_string(),
          message: Some(e.message),
        }),
      });
    }
  };

  match outcome {
    model::TrainOutcome::InsufficientSamples => Ok(TrainSelectionGbdtResult {
      status: "insufficient_samples".to_string(),
      model_revision: None,
      model_path: None,
      failed: None,
    }),
    model::TrainOutcome::Trained(ok) => {
      if let Err(e) = fs::write(&model_path, ok.model_bytes) {
        return Ok(TrainSelectionGbdtResult {
          status: "failed".to_string(),
          model_revision: None,
          model_path: None,
          failed: Some(SelectionFailed {
            error_code: SelectionErrorCode::InternalError.as_str().to_string(),
            message: Some(format!("写入模型失败: {}", e)),
          }),
        });
      }

      let openl3_model_version = std::env::var("FRKB_OPENL3_MODEL_VERSION")
        .ok()
        .and_then(|s| {
          let t = s.trim().to_string();
          if t.is_empty() { None } else { Some(t) }
        });

      let manifest = SelectionManifest {
        schema_version: 1,
        model_revision: ok.model_revision,
        gbdt_model_version: model::GBDT_MODEL_VERSION.to_string(),
        gbdt_model_file: ok.manifest_model_file,
        openl3_model_version,
        updated_at: trained_at_ms,
      };
      if let Err(e) = write_manifest(&manifest_path, &manifest) {
        return Ok(TrainSelectionGbdtResult {
          status: "failed".to_string(),
          model_revision: None,
          model_path: None,
          failed: Some(SelectionFailed {
            error_code: SelectionErrorCode::InternalError.as_str().to_string(),
            message: Some(e),
          }),
        });
      }

      // 训练成功后清理旧 modelRevision 缓存
      let _ = feature_store::delete_prediction_cache_except_revision(&conn, ok.model_revision);

      Ok(TrainSelectionGbdtResult {
        status: "trained".to_string(),
        model_revision: Some(ok.model_revision),
        model_path: Some(model_path.to_string_lossy().to_string()),
        failed: None,
      })
    }
  }
}

#[napi]
pub fn predict_selection_candidates(
  candidate_ids: Vec<String>,
  feature_store_path: String,
  model_path: Option<String>,
  top_k: Option<u32>,
) -> napi::Result<PredictSelectionCandidatesResult> {
  let db_path = normalize_feature_store_path(&feature_store_path);
  if db_path.as_os_str().is_empty() {
    return Ok(PredictSelectionCandidatesResult {
      status: "failed".to_string(),
      model_revision: None,
      items: None,
      failed: Some(SelectionFailed {
        error_code: SelectionErrorCode::InternalError.as_str().to_string(),
        message: Some("featureStorePath 不能为空".to_string()),
      }),
    });
  }

  let Some(library_root) = library_root_from_feature_store_path(&db_path) else {
    return Ok(PredictSelectionCandidatesResult {
      status: "failed".to_string(),
      model_revision: None,
      items: None,
      failed: Some(SelectionFailed {
        error_code: SelectionErrorCode::InternalError.as_str().to_string(),
        message: Some("无法解析库根目录".to_string()),
      }),
    });
  };

  let resolved_model_path = resolve_model_path(&library_root, model_path.as_deref());
  if !resolved_model_path.exists() {
    return Ok(PredictSelectionCandidatesResult {
      status: "not_trained".to_string(),
      model_revision: None,
      items: None,
      failed: None,
    });
  }

  let model_bytes = match fs::read(&resolved_model_path) {
    Ok(b) => b,
    Err(e) => {
      return Ok(PredictSelectionCandidatesResult {
        status: "failed".to_string(),
        model_revision: None,
        items: None,
        failed: Some(SelectionFailed {
          error_code: SelectionErrorCode::ModelLoadFailed.as_str().to_string(),
          message: Some(format!("读取模型失败: {}", e)),
        }),
      });
    }
  };

  let model = match model::load_gbdt_model(&model_bytes) {
    Ok(m) => m,
    Err(e) => {
      return Ok(PredictSelectionCandidatesResult {
        status: "failed".to_string(),
        model_revision: None,
        items: None,
        failed: Some(SelectionFailed {
          error_code: e.error_code.as_str().to_string(),
          message: Some(e.message),
        }),
      });
    }
  };

  let mut conn = match feature_store::open_and_migrate(&db_path) {
    Ok(c) => c,
    Err(e) => {
      return Ok(PredictSelectionCandidatesResult {
        status: "failed".to_string(),
        model_revision: None,
        items: None,
        failed: Some(SelectionFailed {
          error_code: SelectionErrorCode::DbError.as_str().to_string(),
          message: Some(e),
        }),
      });
    }
  };

  let mut all_query_ids = candidate_ids.clone();
  all_query_ids.sort();
  all_query_ids.dedup();
  let candidate_features_map = match feature_store::get_song_features_map(&conn, &all_query_ids) {
    Ok(m) => m,
    Err(e) => {
      return Ok(PredictSelectionCandidatesResult {
        status: "failed".to_string(),
        model_revision: None,
        items: None,
        failed: Some(SelectionFailed {
          error_code: SelectionErrorCode::DbError.as_str().to_string(),
          message: Some(e),
        }),
      });
    }
  };

  let positive_features_map =
    match feature_store::get_song_features_map(&conn, &model.positive_ids) {
      Ok(m) => m,
      Err(e) => {
        return Ok(PredictSelectionCandidatesResult {
          status: "failed".to_string(),
          model_revision: None,
          items: None,
          failed: Some(SelectionFailed {
            error_code: SelectionErrorCode::DbError.as_str().to_string(),
            message: Some(e),
          }),
        });
      }
    };

  let predict_ok = match model::predict_with_model(
    &model,
    candidate_ids,
    &candidate_features_map,
    &positive_features_map,
  ) {
    Ok(ok) => ok,
    Err(e) => {
      return Ok(PredictSelectionCandidatesResult {
        status: "failed".to_string(),
        model_revision: None,
        items: None,
        failed: Some(SelectionFailed {
          error_code: e.error_code.as_str().to_string(),
          message: Some(e.message),
        }),
      });
    }
  };

  // 预测缓存：命中则直接返回；未命中的由本次推理结果回填
  let cached = feature_store::get_prediction_cache_map(&conn, predict_ok.model_revision, &all_query_ids)
    .unwrap_or_default();

  let mut items: Vec<PredictSelectionItem> = Vec::new();
  let mut cache_to_upsert: Vec<(String, i64, String, f32)> = Vec::new();

  for it in predict_ok.items {
    let key = (it.id.clone(), it.file_hash.clone());
    if let Some(score) = cached.get(&key) {
      items.push(PredictSelectionItem {
        id: it.id,
        score: (*score as f64),
      });
    } else {
      items.push(PredictSelectionItem {
        id: it.id.clone(),
        score: it.score as f64,
      });
      cache_to_upsert.push((it.id, predict_ok.model_revision, it.file_hash, it.score));
    }
  }

  // 回写缓存（best effort）
  if !cache_to_upsert.is_empty() {
    let _ = feature_store::upsert_prediction_cache(&mut conn, &cache_to_upsert);
  }

  items.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
  let k = top_k.unwrap_or(100) as usize;
  if items.len() > k {
    items.truncate(k);
  }

  Ok(PredictSelectionCandidatesResult {
    status: "ok".to_string(),
    model_revision: Some(predict_ok.model_revision),
    items: Some(items),
    failed: None,
  })
}

fn resolve_model_path(library_root: &Path, override_path: Option<&str>) -> std::path::PathBuf {
  if let Some(p) = override_path {
    let pp = Path::new(p);
    if pp.is_absolute() {
      return pp.to_path_buf();
    }
    return library_root.join(pp);
  }
  selection_gbdt_model_path(library_root)
}

fn now_millis_string() -> String {
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  ms.to_string()
}
