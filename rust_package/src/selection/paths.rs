use std::path::{Path, PathBuf};

pub fn normalize_feature_store_path(feature_store_path: &str) -> PathBuf {
  if feature_store_path.trim().is_empty() {
    return PathBuf::new();
  }

  let p = Path::new(feature_store_path);
  let is_db_file = p
    .file_name()
    .and_then(|s| s.to_str())
    .map(|s| s.to_ascii_lowercase().ends_with(".db"))
    .unwrap_or(false);
  if is_db_file {
    return p.to_path_buf();
  }

  p.join("features.db")
}

pub fn library_root_from_feature_store_path(feature_store_path: &Path) -> Option<PathBuf> {
  let file_name = feature_store_path.file_name().and_then(|s| s.to_str());
  let is_db_file = file_name
    .map(|s| s.to_ascii_lowercase().ends_with(".db"))
    .unwrap_or(false);
  if is_db_file {
    return feature_store_path.parent().map(|p| p.to_path_buf());
  }
  Some(feature_store_path.to_path_buf())
}

pub fn selection_model_dir(library_root: &Path) -> PathBuf {
  library_root.join("models").join("selection")
}

pub fn selection_manifest_path(library_root: &Path) -> PathBuf {
  selection_model_dir(library_root).join("manifest.json")
}

pub fn selection_gbdt_model_path(library_root: &Path) -> PathBuf {
  selection_model_dir(library_root).join("selection_gbdt_v2.bin")
}

pub fn normalize_label_store_path(label_store_path: &str) -> PathBuf {
  if label_store_path.trim().is_empty() {
    return PathBuf::new();
  }

  let p = Path::new(label_store_path);
  let is_db_file = p
    .file_name()
    .and_then(|s| s.to_str())
    .map(|s| s.to_ascii_lowercase().ends_with(".db"))
    .unwrap_or(false);
  if is_db_file {
    return p.to_path_buf();
  }

  p.join("selection_labels.db")
}

pub fn normalize_path_index_store_path(path_index_store_path: &str) -> PathBuf {
  if path_index_store_path.trim().is_empty() {
    return PathBuf::new();
  }

  let p = Path::new(path_index_store_path);
  let is_db_file = p
    .file_name()
    .and_then(|s| s.to_str())
    .map(|s| s.to_ascii_lowercase().ends_with(".db"))
    .unwrap_or(false);
  if is_db_file {
    return p.to_path_buf();
  }

  p.join("selection_path_index.db")
}
