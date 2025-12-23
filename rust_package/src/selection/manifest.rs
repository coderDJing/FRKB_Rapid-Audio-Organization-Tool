use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionManifest {
  pub schema_version: i32,
  pub model_revision: i64,
  pub gbdt_model_version: String,
  pub gbdt_model_file: String,
  pub openl3_model_version: Option<String>,
  pub updated_at: String,
}

pub fn read_manifest(path: &Path) -> Result<Option<SelectionManifest>, String> {
  if !path.exists() {
    return Ok(None);
  }
  let raw = fs::read_to_string(path).map_err(|e| format!("读取 manifest 失败: {}", e))?;
  let manifest: SelectionManifest =
    serde_json::from_str(&raw).map_err(|e| format!("解析 manifest 失败: {}", e))?;
  Ok(Some(manifest))
}

pub fn write_manifest(path: &Path, manifest: &SelectionManifest) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("创建 models/selection 目录失败: {}", e))?;
  }
  let json = serde_json::to_string_pretty(manifest).map_err(|e| format!("序列化失败: {}", e))?;
  fs::write(path, json).map_err(|e| format!("写入 manifest 失败: {}", e))?;
  Ok(())
}

