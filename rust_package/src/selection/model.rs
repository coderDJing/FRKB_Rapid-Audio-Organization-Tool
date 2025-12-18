use crate::selection::feature_store::SongFeaturesRow;
use gbdt::config::Config;
use gbdt::decision_tree::{Data, DataVec};
use gbdt::gradient_boost::GBDT;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionErrorCode {
  DbError,
  ModelLoadFailed,
  InternalError,
}

impl SelectionErrorCode {
  pub fn as_str(&self) -> &'static str {
    match self {
      SelectionErrorCode::DbError => "db_error",
      SelectionErrorCode::ModelLoadFailed => "model_load_failed",
      SelectionErrorCode::InternalError => "internal_error",
    }
  }
}

#[derive(Debug, Clone)]
pub struct SelectionError {
  pub error_code: SelectionErrorCode,
  pub message: String,
}

#[derive(Debug, Clone)]
pub struct TrainOk {
  pub model_revision: i64,
  pub model_bytes: Vec<u8>,
  pub manifest_model_file: String,
}

#[derive(Debug, Clone)]
pub enum TrainOutcome {
  Trained(TrainOk),
  InsufficientSamples,
}

#[derive(Debug, Clone)]
pub struct PredictItem {
  pub id: String,
  pub score: f32,
  pub file_hash: String,
}

#[derive(Debug, Clone)]
pub struct PredictOk {
  pub model_revision: i64,
  pub items: Vec<PredictItem>,
}

#[derive(Serialize, Deserialize)]
pub struct SelectionGbdtModelV1 {
  pub version: u32,
  pub model_revision: i64,
  pub trained_at_ms: String,
  pub positive_ids: Vec<String>,
  pub feature_names: Vec<String>,
  pub gbdt: GBDT,
}

pub const GBDT_MODEL_VERSION: &str = "selection_gbdt_v1";
pub const GBDT_MODEL_FILE_NAME: &str = "selection_gbdt_v1.bin";

pub fn dedupe_ids(positive_ids: Vec<String>, negative_ids: Vec<String>) -> (Vec<String>, Vec<String>) {
  let mut pos_set: HashSet<String> = positive_ids
    .into_iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
  let mut neg_set: HashSet<String> = negative_ids
    .into_iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();

  // 冲突时以正样本为准
  for id in pos_set.iter() {
    neg_set.remove(id);
  }

  let mut pos: Vec<String> = pos_set.drain().collect();
  let mut neg: Vec<String> = neg_set.drain().collect();
  pos.sort();
  neg.sort();
  (pos, neg)
}

pub fn train_gbdt_model(
  positive_ids: Vec<String>,
  negative_ids: Vec<String>,
  model_revision: i64,
  song_features_map: &HashMap<String, SongFeaturesRow>,
  trained_at_ms: String,
) -> Result<TrainOutcome, SelectionError> {
  let (positive_ids, negative_ids) = dedupe_ids(positive_ids, negative_ids);

  // 样本门槛：positiveIds >= 20 && negativeIds >= 4 * positiveIds
  let pos_n = positive_ids.len();
  let neg_n = negative_ids.len();
  if pos_n < 20 || neg_n < 4 * pos_n {
    return Ok(TrainOutcome::InsufficientSamples);
  }

  // 训练强依赖 features.db：全部样本必须存在 song_features 行
  let mut missing: Vec<String> = Vec::new();
  for id in positive_ids.iter().chain(negative_ids.iter()) {
    if !song_features_map.contains_key(id) {
      missing.push(id.clone());
    }
  }
  if !missing.is_empty() {
    return Err(SelectionError {
      error_code: SelectionErrorCode::DbError,
      message: format!("song_features 缺失: {}", missing.len()),
    });
  }

  let feature_names = feature_names_v1();
  let feature_size = feature_names.len();

  let positive_list: Vec<(&String, &SongFeaturesRow)> = positive_ids
    .iter()
    .filter_map(|id| song_features_map.get_key_value(id))
    .collect();
  let positive_chromaprint = build_positive_chromaprint_simhashes(&positive_list);
  let positive_openl3 = build_positive_openl3_norm_vectors(&positive_list);
  let openl3_centroid = build_openl3_centroid(&positive_openl3);

  let mut dv: DataVec = Vec::with_capacity(pos_n + neg_n);

  for id in &positive_ids {
    let row = song_features_map.get(id).expect("checked above");
    let feat = build_features_for_names(
      row,
      &positive_list,
      &positive_chromaprint,
      &positive_openl3,
      openl3_centroid.as_deref(),
      Some(id.as_str()),
      &feature_names,
    );
    dv.push(Data::new_training_data(feat, 1.0, 1.0, None));
  }
  for id in &negative_ids {
    let row = song_features_map.get(id).expect("checked above");
    let feat = build_features_for_names(
      row,
      &positive_list,
      &positive_chromaprint,
      &positive_openl3,
      openl3_centroid.as_deref(),
      None,
      &feature_names,
    );
    dv.push(Data::new_training_data(feat, 1.0, -1.0, None));
  }

  let mut cfg = Config::new();
  cfg.set_feature_size(feature_size);
  cfg.set_max_depth(6);
  cfg.set_min_leaf_size(1);
  cfg.set_loss("LogLikelyhood");
  cfg.set_iterations(400);
  cfg.set_shrinkage(0.05);
  cfg.set_data_sample_ratio(0.8);
  cfg.set_feature_sample_ratio(0.8);
  cfg.set_training_optimization_level(2);
  cfg.set_debug(false);

  let mut gbdt = GBDT::new(&cfg);
  gbdt.fit(&mut dv);

  let model = SelectionGbdtModelV1 {
    version: 1,
    model_revision,
    trained_at_ms,
    positive_ids,
    feature_names,
    gbdt,
  };

  let model_bytes = bincode::serialize(&model).map_err(|e| SelectionError {
    error_code: SelectionErrorCode::InternalError,
    message: format!("模型序列化失败: {}", e),
  })?;

  Ok(TrainOutcome::Trained(TrainOk {
    model_revision,
    model_bytes,
    manifest_model_file: GBDT_MODEL_FILE_NAME.to_string(),
  }))
}

pub fn load_gbdt_model(bytes: &[u8]) -> Result<SelectionGbdtModelV1, SelectionError> {
  bincode::deserialize(bytes).map_err(|e| SelectionError {
    error_code: SelectionErrorCode::ModelLoadFailed,
    message: format!("模型反序列化失败: {}", e),
  })
}

pub fn predict_with_model(
  model: &SelectionGbdtModelV1,
  candidate_ids: Vec<String>,
  candidate_features_map: &HashMap<String, SongFeaturesRow>,
  positive_features_map: &HashMap<String, SongFeaturesRow>,
) -> Result<PredictOk, SelectionError> {
  let mut candidates: Vec<(String, SongFeaturesRow)> = Vec::new();
  for id in candidate_ids {
    if let Some(row) = candidate_features_map.get(&id) {
      candidates.push((id, row.clone()));
    }
  }

  let positive_list: Vec<(&String, &SongFeaturesRow)> = model
    .positive_ids
    .iter()
    .filter_map(|id| positive_features_map.get_key_value(id))
    .collect();
  let positive_chromaprint = build_positive_chromaprint_simhashes(&positive_list);
  let positive_openl3 = build_positive_openl3_norm_vectors(&positive_list);
  let openl3_centroid = build_openl3_centroid(&positive_openl3);

  if candidates.is_empty() {
    return Ok(PredictOk {
      model_revision: model.model_revision,
      items: Vec::new(),
    });
  }

  let mut dv: DataVec = Vec::with_capacity(candidates.len());
  for (_id, row) in &candidates {
    let feat = build_features_for_names(
      row,
      &positive_list,
      &positive_chromaprint,
      &positive_openl3,
      openl3_centroid.as_deref(),
      None,
      &model.feature_names,
    );
    dv.push(Data::new_test_data(feat, None));
  }

  let preds = model.gbdt.predict(&dv);
  let mut items: Vec<PredictItem> = candidates
    .into_iter()
    .zip(preds.into_iter())
    .map(|((id, row), score)| PredictItem {
      id,
      score,
      file_hash: row.file_hash,
    })
    .collect();

  items.sort_by(|a, b| {
    b.score
      .partial_cmp(&a.score)
      .unwrap_or(Ordering::Equal)
  });

  Ok(PredictOk {
    model_revision: model.model_revision,
    items,
  })
}

fn feature_names_v1() -> Vec<String> {
  vec![
    "hpcp_corr_max".to_string(),
    "bpm_diff_min".to_string(),
    "key_dist_min".to_string(),
    "duration_diff_min_log1p".to_string(),
    "bitrate_kbps".to_string(),
    "rms_mean".to_string(),
    "has_hpcp".to_string(),
    "has_bpm".to_string(),
    "has_key".to_string(),
    "has_duration".to_string(),
    "has_bitrate".to_string(),
    "has_rms".to_string(),
    "chromaprint_sim_max".to_string(),
    "has_chromaprint".to_string(),
    "openl3_sim_max".to_string(),
    "openl3_sim_top5_mean".to_string(),
    "openl3_sim_top20_mean".to_string(),
    "openl3_sim_centroid".to_string(),
    "has_openl3".to_string(),
    "has_openl3_pos".to_string(),
  ]
}

#[derive(Debug, Clone, Copy)]
struct FeatureValuesV1 {
  hpcp_corr_max: f32,
  bpm_diff_min: f32,
  key_dist_min: f32,
  duration_diff_min_log1p: f32,
  bitrate_kbps: f32,
  rms_mean: f32,
  has_hpcp: f32,
  has_bpm: f32,
  has_key: f32,
  has_duration: f32,
  has_bitrate: f32,
  has_rms: f32,
  chromaprint_sim_max: f32,
  has_chromaprint: f32,
  openl3_sim_max: f32,
  openl3_sim_top5_mean: f32,
  openl3_sim_top20_mean: f32,
  openl3_sim_centroid: f32,
  has_openl3: f32,
  has_openl3_pos: f32,
}

fn build_features_for_names(
  candidate: &SongFeaturesRow,
  positive_list: &[(&String, &SongFeaturesRow)],
  positive_chromaprint: &[(String, u64)],
  positive_openl3: &[(String, Vec<f32>)],
  openl3_centroid: Option<&[f32]>,
  exclude_positive_id: Option<&str>,
  feature_names: &[String],
) -> Vec<f32> {
  let v = compute_feature_values_v1(
    candidate,
    positive_list,
    positive_chromaprint,
    positive_openl3,
    openl3_centroid,
    exclude_positive_id,
  );

  feature_names
    .iter()
    .map(|name| match name.as_str() {
      "hpcp_corr_max" => v.hpcp_corr_max,
      "bpm_diff_min" => v.bpm_diff_min,
      "key_dist_min" => v.key_dist_min,
      "duration_diff_min_log1p" => v.duration_diff_min_log1p,
      "bitrate_kbps" => v.bitrate_kbps,
      "rms_mean" => v.rms_mean,
      "has_hpcp" => v.has_hpcp,
      "has_bpm" => v.has_bpm,
      "has_key" => v.has_key,
      "has_duration" => v.has_duration,
      "has_bitrate" => v.has_bitrate,
      "has_rms" => v.has_rms,
      "chromaprint_sim_max" => v.chromaprint_sim_max,
      "has_chromaprint" => v.has_chromaprint,
      "openl3_sim_max" => v.openl3_sim_max,
      "openl3_sim_top5_mean" => v.openl3_sim_top5_mean,
      "openl3_sim_top20_mean" => v.openl3_sim_top20_mean,
      "openl3_sim_centroid" => v.openl3_sim_centroid,
      "has_openl3" => v.has_openl3,
      "has_openl3_pos" => v.has_openl3_pos,
      _ => 0.0,
    })
    .collect()
}

fn compute_feature_values_v1(
  candidate: &SongFeaturesRow,
  positive_list: &[(&String, &SongFeaturesRow)],
  positive_chromaprint: &[(String, u64)],
  positive_openl3: &[(String, Vec<f32>)],
  openl3_centroid: Option<&[f32]>,
  exclude_positive_id: Option<&str>,
) -> FeatureValuesV1 {
  let (hpcp_corr_max, has_hpcp) =
    feature_hpcp_corr_max(candidate, positive_list, exclude_positive_id);
  let (bpm_diff_min, has_bpm) = feature_bpm_diff_min(candidate, positive_list, exclude_positive_id);
  let (key_dist_min, has_key) = feature_key_dist_min(candidate, positive_list, exclude_positive_id);
  let (duration_diff_min, has_duration) =
    feature_duration_diff_min(candidate, positive_list, exclude_positive_id);
  let (bitrate_kbps, has_bitrate) = (
    candidate.bitrate_kbps.unwrap_or(0.0) as f32,
    if candidate.bitrate_kbps.is_some() { 1.0 } else { 0.0 },
  );
  let (rms_mean, has_rms) = (
    candidate.rms_mean.unwrap_or(0.0) as f32,
    if candidate.rms_mean.is_some() { 1.0 } else { 0.0 },
  );

  let duration_diff_min_log1p = (duration_diff_min.max(0.0) + 1.0).ln();
  let (chromaprint_sim_max, has_chromaprint) =
    feature_chromaprint_sim_max(candidate, positive_chromaprint, exclude_positive_id);

  let (
    openl3_sim_max,
    openl3_sim_top5_mean,
    openl3_sim_top20_mean,
    openl3_sim_centroid,
    has_openl3,
    has_openl3_pos,
  ) = feature_openl3_sim_stats(candidate, positive_openl3, openl3_centroid, exclude_positive_id);

  FeatureValuesV1 {
    hpcp_corr_max,
    bpm_diff_min,
    key_dist_min,
    duration_diff_min_log1p,
    bitrate_kbps,
    rms_mean,
    has_hpcp,
    has_bpm,
    has_key,
    has_duration,
    has_bitrate,
    has_rms,
    chromaprint_sim_max,
    has_chromaprint,
    openl3_sim_max,
    openl3_sim_top5_mean,
    openl3_sim_top20_mean,
    openl3_sim_centroid,
    has_openl3,
    has_openl3_pos,
  }
}

fn feature_hpcp_corr_max(
  candidate: &SongFeaturesRow,
  positive_list: &[(&String, &SongFeaturesRow)],
  exclude_positive_id: Option<&str>,
) -> (f32, f32) {
  let Some(ref cand_vec) = candidate.hpcp else {
    return (0.0, 0.0);
  };
  let mut best = 0.0f32;
  let mut any = false;
  for (id, pos) in positive_list {
    if exclude_positive_id.is_some_and(|x| x == id.as_str()) {
      continue;
    }
    let Some(ref pos_vec) = pos.hpcp else {
      continue;
    };
    any = true;
    let sim = cosine_similarity(cand_vec, pos_vec);
    if sim > best {
      best = sim;
    }
  }
  (best, if any { 1.0 } else { 0.0 })
}

fn feature_bpm_diff_min(
  candidate: &SongFeaturesRow,
  positive_list: &[(&String, &SongFeaturesRow)],
  exclude_positive_id: Option<&str>,
) -> (f32, f32) {
  let Some(bpm) = candidate.bpm else {
    return (999.0, 0.0);
  };
  let mut best = f32::INFINITY;
  let mut any = false;
  for (id, pos) in positive_list {
    if exclude_positive_id.is_some_and(|x| x == id.as_str()) {
      continue;
    }
    let Some(p) = pos.bpm else {
      continue;
    };
    any = true;
    best = best.min((bpm - p).abs() as f32);
  }
  if !best.is_finite() {
    best = 999.0;
  }
  (best, if any { 1.0 } else { 0.0 })
}

fn feature_key_dist_min(
  candidate: &SongFeaturesRow,
  positive_list: &[(&String, &SongFeaturesRow)],
  exclude_positive_id: Option<&str>,
) -> (f32, f32) {
  let Some(ref key) = candidate.key else {
    return (99.0, 0.0);
  };
  let Some(cand_code) = parse_key_code(key) else {
    return (99.0, 0.0);
  };

  let mut best = f32::INFINITY;
  let mut any = false;
  for (id, pos) in positive_list {
    if exclude_positive_id.is_some_and(|x| x == id.as_str()) {
      continue;
    }
    let Some(ref pk) = pos.key else {
      continue;
    };
    let Some(pos_code) = parse_key_code(pk) else {
      continue;
    };
    any = true;
    best = best.min(key_distance(cand_code, pos_code));
  }
  if !best.is_finite() {
    best = 99.0;
  }
  (best, if any { 1.0 } else { 0.0 })
}

fn feature_duration_diff_min(
  candidate: &SongFeaturesRow,
  positive_list: &[(&String, &SongFeaturesRow)],
  exclude_positive_id: Option<&str>,
) -> (f32, f32) {
  let Some(d) = candidate.duration_sec else {
    return (999_999.0, 0.0);
  };
  let mut best = f32::INFINITY;
  let mut any = false;
  for (id, pos) in positive_list {
    if exclude_positive_id.is_some_and(|x| x == id.as_str()) {
      continue;
    }
    let Some(pd) = pos.duration_sec else {
      continue;
    };
    any = true;
    best = best.min((d - pd).abs() as f32);
  }
  if !best.is_finite() {
    best = 999_999.0;
  }
  (best, if any { 1.0 } else { 0.0 })
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
  let n = a.len().min(b.len());
  if n == 0 {
    return 0.0;
  }
  let mut dot = 0.0f32;
  let mut na = 0.0f32;
  let mut nb = 0.0f32;
  for i in 0..n {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if na <= 0.0 || nb <= 0.0 {
    return 0.0;
  }
  dot / (na.sqrt() * nb.sqrt())
}

fn parse_key_code(key: &str) -> Option<i32> {
  let raw = key.trim();
  if raw.is_empty() {
    return None;
  }
  let lower = raw.to_ascii_lowercase();
  let mut parts = lower.split(':');
  let root = parts.next()?.trim();
  let mode = parts.next().unwrap_or("maj").trim();

  let pitch = match root {
    "c" => 0,
    "c#" | "db" => 1,
    "d" => 2,
    "d#" | "eb" => 3,
    "e" => 4,
    "f" => 5,
    "f#" | "gb" => 6,
    "g" => 7,
    "g#" | "ab" => 8,
    "a" => 9,
    "a#" | "bb" => 10,
    "b" => 11,
    _ => return None,
  };

  let minor = mode == "min" || mode == "minor" || mode.ends_with('m');
  let code = pitch + if minor { 12 } else { 0 };
  Some(code)
}

fn key_distance(a: i32, b: i32) -> f32 {
  let a_pitch = (a % 12) as i32;
  let b_pitch = (b % 12) as i32;
  let a_mode = a / 12;
  let b_mode = b / 12;
  let diff = (a_pitch - b_pitch).abs();
  let semitone_dist = diff.min(12 - diff) as f32;
  let mode_penalty = if a_mode == b_mode { 0.0 } else { 1.0 };
  semitone_dist + mode_penalty
}

fn build_positive_openl3_norm_vectors(
  positive_list: &[(&String, &SongFeaturesRow)],
) -> Vec<(String, Vec<f32>)> {
  let mut out: Vec<(String, Vec<f32>)> = Vec::new();
  for (id, row) in positive_list {
    let Some(ref v) = row.openl3_vector else {
      continue;
    };
    if v.is_empty() {
      continue;
    }
    let Some(nv) = normalize_vec(v) else {
      continue;
    };
    out.push((id.to_string(), nv));
  }
  out
}

fn build_openl3_centroid(positive_openl3: &[(String, Vec<f32>)]) -> Option<Vec<f32>> {
  if positive_openl3.is_empty() {
    return None;
  }
  let dim = positive_openl3
    .iter()
    .map(|(_, v)| v.len())
    .find(|n| *n > 0)?;
  let mut acc = vec![0f32; dim];
  let mut count = 0usize;
  for (_id, v) in positive_openl3 {
    if v.len() != dim {
      continue;
    }
    for i in 0..dim {
      acc[i] += v[i];
    }
    count += 1;
  }
  if count == 0 {
    return None;
  }
  let inv = 1.0 / (count as f32);
  for x in &mut acc {
    *x *= inv;
  }
  normalize_vec(&acc)
}

fn normalize_vec(v: &[f32]) -> Option<Vec<f32>> {
  let mut sum = 0f64;
  for x in v {
    sum += (*x as f64) * (*x as f64);
  }
  if !sum.is_finite() || sum <= 0.0 {
    return None;
  }
  let inv = 1.0 / (sum.sqrt() as f32);
  Some(v.iter().map(|x| *x * inv).collect())
}

fn dot_similarity(a: &[f32], b: &[f32]) -> f32 {
  let n = a.len().min(b.len());
  if n == 0 {
    return 0.0;
  }
  let mut dot = 0.0f32;
  for i in 0..n {
    dot += a[i] * b[i];
  }
  dot
}

fn feature_openl3_sim_stats(
  candidate: &SongFeaturesRow,
  positive_openl3: &[(String, Vec<f32>)],
  centroid: Option<&[f32]>,
  exclude_positive_id: Option<&str>,
) -> (f32, f32, f32, f32, f32, f32) {
  let Some(ref v) = candidate.openl3_vector else {
    return (0.0, 0.0, 0.0, 0.0, 0.0, if positive_openl3.is_empty() { 0.0 } else { 1.0 });
  };
  if v.is_empty() {
    return (0.0, 0.0, 0.0, 0.0, 0.0, if positive_openl3.is_empty() { 0.0 } else { 1.0 });
  }
  let Some(cand) = normalize_vec(v) else {
    return (0.0, 0.0, 0.0, 0.0, 0.0, if positive_openl3.is_empty() { 0.0 } else { 1.0 });
  };

  let mut sims: Vec<f32> = Vec::with_capacity(positive_openl3.len());
  for (id, pos) in positive_openl3 {
    if exclude_positive_id.is_some_and(|x| x == id.as_str()) {
      continue;
    }
    sims.push(dot_similarity(&cand, pos));
  }

  let centroid_sim = centroid.map(|c| dot_similarity(&cand, c)).unwrap_or(0.0);
  if sims.is_empty() {
    return (0.0, 0.0, 0.0, centroid_sim, 1.0, 0.0);
  }

  sims.sort_by(|a, b| b.partial_cmp(a).unwrap_or(Ordering::Equal));

  let max = sims[0];
  let top5_n = sims.len().min(5);
  let top20_n = sims.len().min(20);
  let top5_mean = sims.iter().take(top5_n).sum::<f32>() / (top5_n as f32);
  let top20_mean = sims.iter().take(top20_n).sum::<f32>() / (top20_n as f32);

  (max, top5_mean, top20_mean, centroid_sim, 1.0, 1.0)
}

fn build_positive_chromaprint_simhashes(
  positive_list: &[(&String, &SongFeaturesRow)],
) -> Vec<(String, u64)> {
  let mut out: Vec<(String, u64)> = Vec::new();
  for (id, row) in positive_list {
    let Some(ref fp) = row.chromaprint_fingerprint else {
      continue;
    };
    let Some(sig) = chromaprint_simhash_from_fingerprint(fp) else {
      continue;
    };
    out.push((id.to_string(), sig));
  }
  out
}

fn feature_chromaprint_sim_max(
  candidate: &SongFeaturesRow,
  positive_chromaprint: &[(String, u64)],
  exclude_positive_id: Option<&str>,
) -> (f32, f32) {
  let Some(ref fp) = candidate.chromaprint_fingerprint else {
    return (0.0, 0.0);
  };
  let Some(cand_sig) = chromaprint_simhash_from_fingerprint(fp) else {
    return (0.0, 0.0);
  };

  let mut best = 0.0f32;
  let mut any = false;
  for (id, pos_sig) in positive_chromaprint {
    if exclude_positive_id.is_some_and(|x| x == id.as_str()) {
      continue;
    }
    any = true;
    let sim = simhash_similarity_64(cand_sig, *pos_sig);
    if sim > best {
      best = sim;
    }
  }
  (best, if any { 1.0 } else { 0.0 })
}

fn simhash_similarity_64(a: u64, b: u64) -> f32 {
  let dist = (a ^ b).count_ones() as f32;
  1.0 - (dist / 64.0)
}

fn chromaprint_simhash_from_fingerprint(fingerprint: &str) -> Option<u64> {
  let raw = fingerprint.trim();
  if raw.is_empty() {
    return None;
  }

  // Chromaprint fpcalc 输出通常为逗号分隔的整数序列。
  // 这里用轻量 SimHash 压缩成 64-bit，用于与正样本集合做相似度特征。
  let mut acc = [0i32; 64];
  let mut any = false;

  // 限制 token 数，避免超长 fingerprint 导致训练/预测开销过大
  const MAX_TOKENS: usize = 4096;
  for (i, part) in raw.split(',').enumerate() {
    if i >= MAX_TOKENS {
      break;
    }
    let p = part.trim();
    if p.is_empty() {
      continue;
    }
    let Ok(v) = p.parse::<i32>() else {
      continue;
    };
    any = true;
    let h = mix64(v as u32 as u64);
    for bit in 0..64 {
      if ((h >> bit) & 1) == 1 {
        acc[bit] += 1;
      } else {
        acc[bit] -= 1;
      }
    }
  }

  if !any {
    return None;
  }

  let mut out: u64 = 0;
  for bit in 0..64 {
    if acc[bit] >= 0 {
      out |= 1u64 << bit;
    }
  }
  Some(out)
}

fn mix64(mut x: u64) -> u64 {
  // SplitMix64 变体：快速、无需额外依赖
  x = x.wrapping_add(0x9e3779b97f4a7c15);
  x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
  x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
  x ^ (x >> 31)
}
