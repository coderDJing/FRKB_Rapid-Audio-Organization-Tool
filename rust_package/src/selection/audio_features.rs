use serde_json::Value;
use crate::selection::essentia_schema::{
  essentia_feature_count,
  GFCC_DIM,
  HIGHLEVEL_CLASS_ORDER,
  LOWLEVEL_FEATURE_ORDER,
  MFCC_DIM,
  RHYTHM_FEATURE_ORDER,
  TONAL_FEATURE_ORDER,
};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct BpmKeyFeatures {
  pub rms_mean: Option<f64>,
  pub hpcp: Option<Vec<f32>>,
  pub bpm: Option<f64>,
  pub key: Option<String>,
  pub duration_sec: Option<f64>,
  pub essentia_vector: Option<Vec<f32>>,
}

#[derive(Clone, Copy)]
enum EssentiaMode {
  BpmKey,
  Full,
}

pub fn extract_bpm_key_from_file(
  file_path: &str,
  max_seconds: f64,
) -> Result<BpmKeyFeatures, String> {
  let mut features = extract_essentia_with_essentia(file_path, max_seconds, EssentiaMode::BpmKey)?;
  if features.key.is_none() {
    if let Some(ref hpcp) = features.hpcp {
      features.key = detect_key_from_chroma(hpcp);
    }
  }
  Ok(features)
}

pub fn extract_full_features_from_file(
  file_path: &str,
  max_seconds: f64,
) -> Result<BpmKeyFeatures, String> {
  let mut features = extract_essentia_with_essentia(file_path, max_seconds, EssentiaMode::Full)?;
  if features.key.is_none() {
    if let Some(ref hpcp) = features.hpcp {
      features.key = detect_key_from_chroma(hpcp);
    }
  }
  Ok(features)
}

fn extract_essentia_with_essentia(
  file_path: &str,
  max_seconds: f64,
  mode: EssentiaMode,
) -> Result<BpmKeyFeatures, String> {
  let bin = env::var("FRKB_ESSENTIA_PATH").map_err(|_| "ESSENTIA_PATH_NOT_SET".to_string())?;
  let bin = bin.trim();
  if bin.is_empty() {
    return Err("ESSENTIA_PATH_EMPTY".to_string());
  }
  let bin_path = PathBuf::from(bin);
  if !bin_path.is_file() {
    return Err("ESSENTIA_BIN_NOT_FOUND".to_string());
  }

  let temp_path = build_temp_json_path().ok_or_else(|| "ESSENTIA_TEMP_PATH_FAILED".to_string())?;
  let profile_path = match mode {
    EssentiaMode::Full => resolve_full_profile_path(&bin_path, max_seconds)
      .or_else(|| resolve_default_profile_path(&bin_path)),
    EssentiaMode::BpmKey => resolve_bpm_key_profile_path(max_seconds),
  };
  let args = build_essentia_args(file_path, &temp_path, max_seconds, profile_path.as_deref());
  let work_dir = bin_path.parent().unwrap_or(Path::new("."));
  let status = Command::new(&bin_path)
    .args(&args)
    .current_dir(work_dir)
    .status()
    .map_err(|_| "ESSENTIA_SPAWN_FAILED".to_string())?;
  if !status.success() {
    let _ = fs::remove_file(&temp_path);
    let code = status.code().unwrap_or(-1);
    return Err(format!("ESSENTIA_EXIT_{}", code));
  }

  let json_text = fs::read_to_string(&temp_path).map_err(|_| {
    let _ = fs::remove_file(&temp_path);
    "ESSENTIA_OUTPUT_READ_FAILED".to_string()
  })?;
  let _ = fs::remove_file(&temp_path);
  let parsed: Value =
    serde_json::from_str(&json_text).map_err(|_| "ESSENTIA_OUTPUT_PARSE_FAILED".to_string())?;
  let mut features = parse_essentia_features(&parsed, mode);
  if features.bpm.is_none()
    && features.key.is_none()
    && features.hpcp.is_none()
    && features.rms_mean.is_none()
    && features.essentia_vector.is_none()
  {
    return Err("ESSENTIA_OUTPUT_EMPTY".to_string());
  }
  if features.key.is_none() {
    if let Some(ref hpcp) = features.hpcp {
      features.key = detect_key_from_chroma(hpcp);
    }
  }
  Ok(features)
}

fn build_temp_json_path() -> Option<PathBuf> {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .map(|d| d.as_millis())?;
  let pid = std::process::id();
  let name = format!("frkb_essentia_{}_{}.json", pid, ts);
  Some(env::temp_dir().join(name))
}

fn resolve_default_profile_path(bin_path: &Path) -> Option<PathBuf> {
  let base = bin_path.parent()?;
  let candidate = base.join("profiles").join("all_config.yaml");
  if candidate.is_file() {
    return Some(candidate);
  }
  None
}

fn resolve_full_profile_path(bin_path: &Path, max_seconds: f64) -> Option<PathBuf> {
  let base = bin_path.parent()?;
  let source = base.join("profiles").join("all_config.yaml");
  if !source.is_file() {
    return None;
  }
  let target = build_profile_path("full", max_seconds)?;
  let raw = fs::read_to_string(&source).ok()?;
  let updated = replace_profile_time_range(&raw, max_seconds);
  ensure_profile_file(&target, &updated).ok()?;
  Some(target)
}

fn resolve_bpm_key_profile_path(max_seconds: f64) -> Option<PathBuf> {
  let target = build_profile_path("bpmkey", max_seconds)?;
  let profile = build_bpm_key_profile(max_seconds);
  ensure_profile_file(&target, &profile).ok()?;
  Some(target)
}

fn build_profile_path(kind: &str, max_seconds: f64) -> Option<PathBuf> {
  let secs = if max_seconds.is_finite() && max_seconds > 0.0 {
    max_seconds.round().max(1.0) as i64
  } else {
    30
  };
  let dir = env::temp_dir().join("frkb_essentia_profiles");
  if fs::create_dir_all(&dir).is_err() {
    return None;
  }
  Some(dir.join(format!("frkb_essentia_profile_{}_{}s.yaml", kind, secs)))
}

fn ensure_profile_file(path: &Path, contents: &str) -> io::Result<()> {
  if let Ok(existing) = fs::read_to_string(path) {
    if existing == contents {
      return Ok(());
    }
  }
  fs::write(path, contents)
}

fn replace_profile_time_range(src: &str, max_seconds: f64) -> String {
  let end_time = if max_seconds.is_finite() && max_seconds > 0.0 {
    max_seconds
  } else {
    30.0
  };
  let mut out: Vec<String> = Vec::new();
  for line in src.lines() {
    let trimmed = line.trim_start();
    if trimmed.starts_with("startTime:") {
      let indent = &line[..line.len() - trimmed.len()];
      out.push(format!("{}startTime: 0.0", indent));
      continue;
    }
    if trimmed.starts_with("endTime:") {
      let indent = &line[..line.len() - trimmed.len()];
      out.push(format!("{}endTime: {}", indent, end_time));
      continue;
    }
    out.push(line.to_string());
  }
  if out.is_empty() {
    return src.to_string();
  }
  out.join("\n")
}

fn build_bpm_key_profile(max_seconds: f64) -> String {
  let end_time = if max_seconds.is_finite() && max_seconds > 0.0 {
    max_seconds
  } else {
    30.0
  };
  let short_sound = end_time > 0.0 && end_time < 2.0;
  format!(
    r#"#### GENERAL ####
analysisSampleRate: 22050
startTime: 0.0
endTime: {end_time}
equalLoudness: true
nequalLoudness: true
shortSound: {short_sound}

svm:
    compute: false

segmentation:
    compute: false
    minimumSegmentsLength: 10.0

lowlevel:
    compute: false

average_loudness:
    compute: false

rhythm:
    compute: true
    useOnset: true
    useBands: false
    numberFrames: 512
    hopSize: 256
    frameSize: 1024
    frameHop: 1024
    stats: [ "mean", "median", "var", "min", "max", "dmean", "dmean2", "dvar", "dvar2" ]

tonal:
    compute: true
    frameSize: 4096
    hopSize: 2048
    windowType: 'blackmanharris62'
    stats: [ "mean", "median", "var", "min", "max", "dmean", "dmean2", "dvar", "dvar2" ]

sfx:
    compute: false

panning:
    compute: false
"#
  )
}

fn build_essentia_args(
  file_path: &str,
  output_path: &Path,
  max_seconds: f64,
  profile_path: Option<&Path>,
) -> Vec<String> {
  let output = output_path.to_string_lossy().to_string();
  let profile = profile_path.map(|p| p.to_string_lossy().to_string());
  if let Ok(raw) = env::var("FRKB_ESSENTIA_ARGS") {
    let template = raw.trim();
    if !template.is_empty() {
      let mut args = split_essentia_args(template);
      let has_placeholder = args.iter().any(|item| {
        item.contains("{input}")
          || item.contains("{output}")
          || item.contains("{max_seconds}")
          || item.contains("{profile}")
      });
      let max_token = format!("{}", max_seconds.round().max(0.0) as i64);
      for item in &mut args {
        *item = item
          .replace("{input}", file_path)
          .replace("{output}", &output)
          .replace("{max_seconds}", &max_token)
          .replace("{profile}", profile.as_deref().unwrap_or(""));
      }
      if !has_placeholder {
        args.push(file_path.to_string());
        args.push(output);
      }
      if let Some(profile) = profile {
        if !args.iter().any(|item| item == &profile) {
          args.push(profile);
        }
      }
      return args;
    }
  }
  if let Some(profile) = profile {
    vec![file_path.to_string(), output, profile]
  } else {
    vec![file_path.to_string(), output]
  }
}

fn split_essentia_args(template: &str) -> Vec<String> {
  let mut args: Vec<String> = Vec::new();
  let mut current = String::new();
  let mut in_single = false;
  let mut in_double = false;
  let mut escaped = false;

  for ch in template.chars() {
    if escaped {
      current.push(ch);
      escaped = false;
      continue;
    }
    match ch {
      '\\' => {
        escaped = true;
      }
      '\'' if !in_double => {
        in_single = !in_single;
      }
      '"' if !in_single => {
        in_double = !in_double;
      }
      c if c.is_whitespace() && !in_single && !in_double => {
        if !current.is_empty() {
          args.push(current.clone());
          current.clear();
        }
      }
      _ => current.push(ch),
    }
  }
  if !current.is_empty() {
    args.push(current);
  }
  args
}

fn parse_essentia_features(root: &Value, mode: EssentiaMode) -> BpmKeyFeatures {
  let bpm = find_number(
    root,
    &[
      &["rhythm", "bpm"],
      &["rhythm", "bpm_estimate"],
      &["bpm"],
    ],
  );
  let key_root = find_string(root, &[&["tonal", "key_key"], &["tonal", "key_key_krumhansl"]]);
  let key_scale =
    find_string(root, &[&["tonal", "key_scale"], &["tonal", "key_scale_krumhansl"]]);
  let key = if let (Some(root), Some(scale)) = (key_root.as_deref(), key_scale.as_deref()) {
    normalize_key_label(root, scale)
  } else {
    let raw = find_string(
      root,
      &[&["tonal", "key"], &["tonal", "key_edma"], &["key"]],
    );
    raw.as_deref().and_then(parse_key_label)
  };

  let hpcp = find_hpcp(root);
  let rms_mean = find_rms_mean(root);
  let duration_sec = find_number(
    root,
    &[
      &["metadata", "duration"],
      &["metadata", "audio_properties", "duration"],
      &["metadata", "audio_properties", "length"],
    ],
  );
  let essentia_vector = if matches!(mode, EssentiaMode::Full) {
    build_essentia_vector(root)
  } else {
    None
  };

  BpmKeyFeatures {
    rms_mean,
    hpcp,
    bpm,
    key,
    duration_sec,
    essentia_vector,
  }
}

fn build_essentia_vector(root: &Value) -> Option<Vec<f32>> {
  let mut out: Vec<f32> = Vec::with_capacity(essentia_feature_count());
  let mut any = false;

  for (group, classes) in HIGHLEVEL_CLASS_ORDER {
    for class in *classes {
      let v = read_highlevel_prob(root, group, class);
      if v.is_some() {
        any = true;
      }
      out.push(v.unwrap_or(0.0) as f32);
    }
  }

  for key in RHYTHM_FEATURE_ORDER {
    let v = match *key {
      "beats_loudness_mean" => find_stat_mean(root, &["rhythm", "beats_loudness"]),
      other => find_number(root, &[&["rhythm", other]]),
    };
    if v.is_some() {
      any = true;
    }
    out.push(v.unwrap_or(0.0) as f32);
  }

  for key in TONAL_FEATURE_ORDER {
    let v = find_number(root, &[&["tonal", key]]);
    if v.is_some() {
      any = true;
    }
    out.push(v.unwrap_or(0.0) as f32);
  }

  for key in LOWLEVEL_FEATURE_ORDER {
    let v = match *key {
      "dynamic_complexity" => find_number(root, &[&["lowlevel", "dynamic_complexity"]]),
      "average_loudness" => find_number(root, &[&["lowlevel", "average_loudness"]]),
      "dissonance_mean" => find_stat_mean(root, &["lowlevel", "dissonance"]),
      "spectral_centroid_mean" => find_stat_mean(root, &["lowlevel", "spectral_centroid"]),
      "spectral_flux_mean" => find_stat_mean(root, &["lowlevel", "spectral_flux"]),
      "spectral_flatness_db_mean" => find_stat_mean(root, &["lowlevel", "spectral_flatness_db"]),
      "spectral_rolloff_mean" => find_stat_mean(root, &["lowlevel", "spectral_rolloff"]),
      "spectral_rms_mean" => find_stat_mean(root, &["lowlevel", "spectral_rms"]),
      _ => None,
    };
    if v.is_some() {
      any = true;
    }
    out.push(v.unwrap_or(0.0) as f32);
  }

  let mfcc = find_array_values(root, &["lowlevel", "mfcc", "mean"])
    .or_else(|| find_array_values(root, &["lowlevel", "mfcc"]));
  let gfcc = find_array_values(root, &["lowlevel", "gfcc", "mean"])
    .or_else(|| find_array_values(root, &["lowlevel", "gfcc"]));

  let mut push_vec = |values: Option<Vec<f32>>, dim: usize| {
    if let Some(vals) = values {
      if !vals.is_empty() {
        any = true;
      }
      for i in 0..dim {
        out.push(*vals.get(i).unwrap_or(&0.0));
      }
    } else {
      out.extend(std::iter::repeat(0.0).take(dim));
    }
  };

  push_vec(mfcc, MFCC_DIM);
  push_vec(gfcc, GFCC_DIM);

  if any {
    Some(out)
  } else {
    None
  }
}

fn read_highlevel_prob(root: &Value, classifier: &str, class_key: &str) -> Option<f64> {
  find_value(root, &["highlevel", classifier, "all", class_key]).and_then(json_number)
}

fn find_stat_mean(root: &Value, path: &[&str]) -> Option<f64> {
  let value = find_value(root, path)?;
  if let Some(n) = json_number(value) {
    return Some(n);
  }
  if let Some(v) = value.get("mean") {
    if let Some(n) = json_number(v) {
      return Some(n);
    }
    if let Some(m) = mean_from_array(v) {
      return Some(m);
    }
  }
  mean_from_array(value)
}

fn find_array_values(root: &Value, path: &[&str]) -> Option<Vec<f32>> {
  let value = find_value(root, path)?;
  let arr = value.as_array()?;
  if arr.is_empty() {
    return None;
  }
  let mut out: Vec<f32> = Vec::with_capacity(arr.len());
  for v in arr {
    let Some(n) = json_number(v) else { return None };
    out.push(n as f32);
  }
  Some(out)
}

fn find_rms_mean(root: &Value) -> Option<f64> {
  if let Some(value) = find_value(root, &["lowlevel", "rms", "mean"]) {
    if let Some(n) = json_number(value) {
      return Some(n);
    }
  }
  if let Some(value) = find_value(root, &["lowlevel", "rms"]) {
    return mean_from_array(value);
  }
  None
}

fn find_hpcp(root: &Value) -> Option<Vec<f32>> {
  let candidates = [
    &["tonal", "hpcp"],
    &["tonal", "hpcp_averaged"],
    &["tonal", "hpcp_mean"],
    &["tonal", "hpcp_highres"],
  ];
  for path in candidates {
    if let Some(value) = find_value(root, path) {
      if let Some(vec) = parse_hpcp_array(value) {
        return Some(vec);
      }
    }
  }
  None
}

fn parse_hpcp_array(value: &Value) -> Option<Vec<f32>> {
  let arr = value.as_array()?;
  if arr.len() < 12 {
    return None;
  }
  let mut values: Vec<f32> = Vec::with_capacity(arr.len());
  for v in arr {
    let Some(n) = json_number(v) else { return None };
    values.push(n as f32);
  }
  let mut out = if values.len() == 12 {
    values
  } else {
    let mut folded = vec![0f32; 12];
    for (idx, v) in values.iter().enumerate() {
      folded[idx % 12] += *v;
    }
    folded
  };
  normalize_chroma(&mut out);
  Some(out)
}

fn mean_from_array(value: &Value) -> Option<f64> {
  let arr = value.as_array()?;
  if arr.is_empty() {
    return None;
  }
  let mut sum = 0.0f64;
  let mut count = 0usize;
  for item in arr {
    if let Some(n) = json_number(item) {
      sum += n;
      count += 1;
    }
  }
  if count == 0 {
    return None;
  }
  Some(sum / count as f64)
}

fn find_number(root: &Value, paths: &[&[&str]]) -> Option<f64> {
  for path in paths {
    if let Some(v) = find_value(root, path) {
      if let Some(n) = json_number(v) {
        return Some(n);
      }
    }
  }
  None
}

fn find_string(root: &Value, paths: &[&[&str]]) -> Option<String> {
  for path in paths {
    if let Some(v) = find_value(root, path) {
      if let Some(s) = json_string(v) {
        return Some(s);
      }
    }
  }
  None
}

fn find_value<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
  let mut current = root;
  for key in path {
    match current {
      Value::Object(map) => {
        current = map.get(*key)?;
      }
      _ => return None,
    }
  }
  Some(current)
}

fn json_number(value: &Value) -> Option<f64> {
  if let Some(n) = value.as_f64() {
    return Some(n);
  }
  if let Some(n) = value.as_i64() {
    return Some(n as f64);
  }
  if let Some(n) = value.as_u64() {
    return Some(n as f64);
  }
  None
}

fn json_string(value: &Value) -> Option<String> {
  value.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn normalize_key_label(root: &str, scale: &str) -> Option<String> {
  let mut root = root.trim().to_string();
  if root.is_empty() {
    return None;
  }
  let scale_trimmed = scale.trim();
  let mut is_minor = scale_trimmed.to_lowercase().starts_with('m');
  if scale_trimmed.is_empty() && root.ends_with('m') {
    root = root.trim_end_matches('m').to_string();
    is_minor = true;
  }

  let mut chars = root.chars();
  let letter = chars.next()?.to_ascii_uppercase();
  if !matches!(letter, 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G') {
    return None;
  }
  let mut root_norm = String::new();
  root_norm.push(letter);
  if let Some(next) = chars.next() {
    if next == '#' || next == 'b' || next == 'B' {
      root_norm.push(if next == 'B' { 'b' } else { next });
    }
  }
  Some(format!("{}{}", root_norm, if is_minor { "m" } else { "" }))
}

fn parse_key_label(raw: &str) -> Option<String> {
  let text = raw.trim();
  if text.is_empty() {
    return None;
  }
  let parts: Vec<&str> = text.split_whitespace().collect();
  if parts.is_empty() {
    return None;
  }
  let root = parts[0];
  let scale = if parts.len() > 1 { parts[1] } else { "" };
  normalize_key_label(root, scale).or_else(|| normalize_key_label(root, ""))
}

fn normalize_chroma(values: &mut [f32]) {
  let mut sum = 0.0f64;
  for v in values.iter() {
    let x = *v as f64;
    sum += x * x;
  }
  let norm = sum.sqrt();
  if norm <= 0.0 {
    return;
  }
  let inv = (1.0 / norm) as f32;
  for v in values.iter_mut() {
    *v *= inv;
  }
}

fn detect_key_from_chroma(chroma: &[f32]) -> Option<String> {
  if chroma.len() < 12 {
    return None;
  }
  let mut energy = 0.0f64;
  for v in chroma {
    let x = *v as f64;
    energy += x * x;
  }
  if energy <= 0.0 {
    return None;
  }

  let major = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
  ];
  let minor = [
    6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
  ];
  let roots = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  let score_for = |profile: &[f64; 12], shift: usize| -> f64 {
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..12 {
      let a = chroma[i] as f64;
      let b = profile[(i + 12 - shift) % 12];
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    if na <= 0.0 || nb <= 0.0 {
      return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
  };

  let mut best_score = 0.0f64;
  let mut best_root = 0usize;
  let mut best_mode = "maj";
  for shift in 0..12 {
    let s_maj = score_for(&major, shift);
    if s_maj > best_score {
      best_score = s_maj;
      best_root = shift;
      best_mode = "maj";
    }
    let s_min = score_for(&minor, shift);
    if s_min > best_score {
      best_score = s_min;
      best_root = shift;
      best_mode = "min";
    }
  }

  let root = roots[best_root];
  let key = if best_mode == "min" {
    format!("{}m", root)
  } else {
    root.to_string()
  };
  Some(key)
}
