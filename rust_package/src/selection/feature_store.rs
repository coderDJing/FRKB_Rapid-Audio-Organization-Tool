use rusqlite::{params, Connection, OptionalExtension};
use rusqlite::types::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const FEATURES_DB_SCHEMA_VERSION: i32 = 2;

#[derive(Debug, Clone)]
pub struct SongFeaturesPatch {
  pub song_id: String,
  pub file_hash: String,
  pub model_version: String,
  pub openl3_vector: Option<Vec<u8>>,
  pub chromaprint_fingerprint: Option<String>,
  pub rms_mean: Option<f64>,
  pub hpcp: Option<Vec<u8>>,
  pub bpm: Option<f64>,
  pub key: Option<String>,
  pub duration_sec: Option<f64>,
  pub bitrate_kbps: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct SongFeaturesRow {
  pub song_id: String,
  pub file_hash: String,
  pub openl3_vector: Option<Vec<f32>>,
  pub chromaprint_fingerprint: Option<String>,
  pub rms_mean: Option<f64>,
  pub hpcp: Option<Vec<f32>>,
  pub bpm: Option<f64>,
  pub key: Option<String>,
  pub duration_sec: Option<f64>,
  pub bitrate_kbps: Option<f64>,
}

pub fn open_and_migrate(feature_store_path: &Path) -> Result<Connection, String> {
  if let Some(parent) = feature_store_path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("创建 features.db 目录失败: {}", e))?;
  }

  let conn = Connection::open(feature_store_path).map_err(|e| format!("打开 features.db 失败: {}", e))?;
  // 并发友好
  let _ = conn.pragma_update(None, "journal_mode", "WAL");
  let _ = conn.pragma_update(None, "synchronous", "NORMAL");
  let _ = conn.pragma_update(None, "foreign_keys", "ON");
  ensure_schema(&conn)?;
  Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      "#,
    )
    .map_err(|e| format!("创建 schema_meta 失败: {}", e))?;

  let existing: Option<String> = conn
    .query_row(
      "SELECT value FROM schema_meta WHERE key = 'schemaVersion' LIMIT 1",
      [],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 schemaVersion 失败: {}", e))?;

  if existing.is_none() {
    // v2 初始化
    conn
      .execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS song_features (
          songId TEXT PRIMARY KEY,
          fileHash TEXT,
          modelVersion TEXT,
          openl3_vector BLOB,
          chromaprintFingerprint TEXT,
          rmsMean REAL,
          hpcp BLOB,
          bpm REAL,
          key TEXT,
          durationSec REAL,
          bitrateKbps REAL,
          updatedAt TEXT
        );

        CREATE TABLE IF NOT EXISTS song_prediction_cache (
          songId TEXT,
          modelRevision INTEGER,
          fileHash TEXT,
          score REAL,
          updatedAt TEXT,
          PRIMARY KEY(songId, modelRevision, fileHash)
        );

        CREATE INDEX IF NOT EXISTS idx_song_features_fileHash ON song_features(fileHash);
        CREATE INDEX IF NOT EXISTS idx_song_features_modelVersion ON song_features(modelVersion);
        CREATE INDEX IF NOT EXISTS idx_song_features_updatedAt ON song_features(updatedAt);
        CREATE INDEX IF NOT EXISTS idx_pred_cache_modelRevision ON song_prediction_cache(modelRevision);
        CREATE INDEX IF NOT EXISTS idx_pred_cache_songId ON song_prediction_cache(songId);
        "#,
      )
      .map_err(|e| format!("初始化 features.db schema 失败: {}", e))?;

    conn
      .execute(
        "INSERT INTO schema_meta(key, value) VALUES('schemaVersion', ?1)",
        params![FEATURES_DB_SCHEMA_VERSION.to_string()],
      )
      .map_err(|e| format!("写入 schemaVersion 失败: {}", e))?;
    return Ok(());
  }

  let current: i32 = existing
    .unwrap_or_else(|| "0".to_string())
    .parse()
    .unwrap_or(0);
  if current > FEATURES_DB_SCHEMA_VERSION {
    return Err(format!(
      "features.db schemaVersion 过新：{} > {}",
      current, FEATURES_DB_SCHEMA_VERSION
    ));
  }

  // 迁移入口
  let mut version = current;
  if version < 2 {
    migrate_to_v2(conn)?;
    version = 2;
  }

  if version != current {
    conn
      .execute(
        "INSERT INTO schema_meta(key, value) VALUES('schemaVersion', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![version.to_string()],
      )
      .map_err(|e| format!("写入 schemaVersion 失败: {}", e))?;
  }
  Ok(())
}

fn migrate_to_v2(conn: &Connection) -> Result<(), String> {
  // 增加 Chromaprint 指纹列（TEXT：存储 fpcalc fingerprint 字符串）
  match conn.execute(
    "ALTER TABLE song_features ADD COLUMN chromaprintFingerprint TEXT",
    [],
  ) {
    Ok(_) => {}
    Err(e) => {
      // 忽略重复添加（兼容部分迁移/手动修改）
      if !e.to_string().to_lowercase().contains("duplicate column") {
        return Err(format!("迁移到 v2 失败: {}", e));
      }
    }
  }
  Ok(())
}

pub fn upsert_song_features(
  conn: &mut Connection,
  items: &[SongFeaturesPatch],
) -> Result<usize, String> {
  if items.is_empty() {
    return Ok(0);
  }
  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  let now = now_millis_string();

  let mut affected = 0usize;
  {
    let mut stmt = tx
      .prepare(
        r#"
        INSERT INTO song_features (
          songId, fileHash, modelVersion, openl3_vector, chromaprintFingerprint, rmsMean, hpcp, bpm, key, durationSec, bitrateKbps, updatedAt
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
        )
        ON CONFLICT(songId) DO UPDATE SET
          fileHash = excluded.fileHash,
          modelVersion = excluded.modelVersion,
          openl3_vector = COALESCE(excluded.openl3_vector, song_features.openl3_vector),
          chromaprintFingerprint = COALESCE(excluded.chromaprintFingerprint, song_features.chromaprintFingerprint),
          rmsMean = COALESCE(excluded.rmsMean, song_features.rmsMean),
          hpcp = COALESCE(excluded.hpcp, song_features.hpcp),
          bpm = COALESCE(excluded.bpm, song_features.bpm),
          key = COALESCE(excluded.key, song_features.key),
          durationSec = COALESCE(excluded.durationSec, song_features.durationSec),
          bitrateKbps = COALESCE(excluded.bitrateKbps, song_features.bitrateKbps),
          updatedAt = excluded.updatedAt
        "#,
      )
      .map_err(|e| format!("准备 upsert 失败: {}", e))?;

    for it in items {
      affected += stmt
        .execute(params![
          it.song_id.as_str(),
          it.file_hash.as_str(),
          it.model_version.as_str(),
          it.openl3_vector.as_deref(),
          it.chromaprint_fingerprint.as_deref(),
          it.rms_mean,
          it.hpcp.as_deref(),
          it.bpm,
          it.key.as_deref(),
          it.duration_sec,
          it.bitrate_kbps,
          now.as_str(),
        ])
        .map_err(|e| format!("写入 song_features 失败: {}", e))?;
    }
  }

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(affected)
}

pub fn get_song_features_map(
  conn: &Connection,
  song_ids: &[String],
) -> Result<HashMap<String, SongFeaturesRow>, String> {
  let mut map = HashMap::new();
  if song_ids.is_empty() {
    return Ok(map);
  }

  let placeholders = (0..song_ids.len())
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(",");
  let sql = format!(
    "SELECT songId, fileHash, openl3_vector, chromaprintFingerprint, rmsMean, hpcp, bpm, key, durationSec, bitrateKbps FROM song_features WHERE songId IN ({})",
    placeholders
  );

  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| format!("准备查询 song_features 失败: {}", e))?;

  let rows = stmt
    .query_map(
      rusqlite::params_from_iter(song_ids.iter().map(|s| s.as_str())),
      |row| {
      let song_id: String = row.get(0)?;
      let file_hash: String = row.get(1)?;
      let openl3_blob: Option<Vec<u8>> = row.get(2)?;
      let chromaprint_fingerprint: Option<String> = row.get(3)?;
      let rms_mean: Option<f64> = row.get(4)?;
      let hpcp_blob: Option<Vec<u8>> = row.get(5)?;
      let bpm: Option<f64> = row.get(6)?;
      let key: Option<String> = row.get(7)?;
      let duration_sec: Option<f64> = row.get(8)?;
      let bitrate_kbps: Option<f64> = row.get(9)?;

      Ok(SongFeaturesRow {
        song_id,
        file_hash,
        openl3_vector: openl3_blob.and_then(|b| parse_f32_le_blob(&b).ok()),
        chromaprint_fingerprint,
        rms_mean,
        hpcp: hpcp_blob.and_then(|b| parse_f32_le_blob(&b).ok()),
        bpm,
        key,
        duration_sec,
        bitrate_kbps,
      })
    },
    )
    .map_err(|e| format!("执行查询 song_features 失败: {}", e))?;

  for r in rows {
    let row = r.map_err(|e| format!("读取 song_features 行失败: {}", e))?;
    map.insert(row.song_id.clone(), row);
  }
  Ok(map)
}

pub fn get_song_feature_status_map(
  conn: &Connection,
  song_ids: &[String],
) -> Result<HashMap<String, bool>, String> {
  let mut map: HashMap<String, bool> = HashMap::new();
  if song_ids.is_empty() {
    return Ok(map);
  }

  let placeholders = (0..song_ids.len())
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(",");
  let sql = format!(
    "SELECT songId, openl3_vector, chromaprintFingerprint, rmsMean, hpcp, bpm, key, durationSec, bitrateKbps FROM song_features WHERE songId IN ({})",
    placeholders
  );

  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| format!("准备查询 song_features(status) 失败: {}", e))?;

  let rows = stmt
    .query_map(
      rusqlite::params_from_iter(song_ids.iter().map(|s| s.as_str())),
      |row| {
        let song_id: String = row.get(0)?;
        let openl3_blob: Option<Vec<u8>> = row.get(1)?;
        let chromaprint_fingerprint: Option<String> = row.get(2)?;
        let rms_mean: Option<f64> = row.get(3)?;
        let hpcp_blob: Option<Vec<u8>> = row.get(4)?;
        let bpm: Option<f64> = row.get(5)?;
        let key: Option<String> = row.get(6)?;
        let duration_sec: Option<f64> = row.get(7)?;
        let bitrate_kbps: Option<f64> = row.get(8)?;

        let has_features =
          openl3_blob.as_ref().is_some_and(|b| !b.is_empty())
            || hpcp_blob.as_ref().is_some_and(|b| !b.is_empty())
            || chromaprint_fingerprint
              .as_ref()
              .is_some_and(|s| !s.trim().is_empty())
            || rms_mean.is_some()
            || bpm.is_some()
            || key.as_ref().is_some_and(|s| !s.trim().is_empty())
            || duration_sec.is_some()
            || bitrate_kbps.is_some();

        Ok((song_id, has_features))
      },
    )
    .map_err(|e| format!("执行查询 song_features(status) 失败: {}", e))?;

  for r in rows {
    let (song_id, has_features) =
      r.map_err(|e| format!("读取 song_features(status) 行失败: {}", e))?;
    map.insert(song_id, has_features);
  }

  Ok(map)
}

pub fn get_prediction_cache_map(
  conn: &Connection,
  model_revision: i64,
  song_ids: &[String],
) -> Result<HashMap<(String, String), f32>, String> {
  let mut map: HashMap<(String, String), f32> = HashMap::new();
  if song_ids.is_empty() {
    return Ok(map);
  }

  let placeholders = (0..song_ids.len())
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(",");
  let sql = format!(
    "SELECT songId, fileHash, score FROM song_prediction_cache WHERE modelRevision = ? AND songId IN ({})",
    placeholders
  );

  let mut params_vec: Vec<Value> = Vec::with_capacity(song_ids.len() + 1);
  params_vec.push(Value::Integer(model_revision));
  params_vec.extend(song_ids.iter().cloned().map(Value::Text));

  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| format!("准备查询 song_prediction_cache 失败: {}", e))?;

  let rows = stmt
    .query_map(rusqlite::params_from_iter(params_vec), |row| {
      let song_id: String = row.get(0)?;
      let file_hash: String = row.get(1)?;
      let score: f64 = row.get(2)?;
      Ok(((song_id, file_hash), score as f32))
    })
    .map_err(|e| format!("执行查询 song_prediction_cache 失败: {}", e))?;

  for r in rows {
    let (k, v) = r.map_err(|e| format!("读取 song_prediction_cache 行失败: {}", e))?;
    map.insert(k, v);
  }
  Ok(map)
}

pub fn upsert_prediction_cache(
  conn: &mut Connection,
  items: &[(String, i64, String, f32)],
) -> Result<usize, String> {
  if items.is_empty() {
    return Ok(0);
  }
  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;
  let now = now_millis_string();

  let mut affected = 0usize;
  {
    let mut stmt = tx
      .prepare(
        r#"
        INSERT INTO song_prediction_cache (songId, modelRevision, fileHash, score, updatedAt)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(songId, modelRevision, fileHash) DO UPDATE SET
          score = excluded.score,
          updatedAt = excluded.updatedAt
        "#,
      )
      .map_err(|e| format!("准备 upsert song_prediction_cache 失败: {}", e))?;

    for (song_id, model_revision, file_hash, score) in items {
      affected += stmt
        .execute(params![
          song_id.as_str(),
          model_revision,
          file_hash.as_str(),
          *score as f64,
          now.as_str()
        ])
        .map_err(|e| format!("写入 song_prediction_cache 失败: {}", e))?;
    }
  }

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(affected)
}

pub fn delete_prediction_cache_except_revision(
  conn: &Connection,
  keep_revision: i64,
) -> Result<usize, String> {
  conn
    .execute(
      "DELETE FROM song_prediction_cache WHERE modelRevision != ?1",
      params![keep_revision],
    )
    .map_err(|e| format!("清理 song_prediction_cache 失败: {}", e))
}

pub fn delete_prediction_cache_for_song_ids(
  conn: &Connection,
  song_ids: &[String],
) -> Result<usize, String> {
  if song_ids.is_empty() {
    return Ok(0);
  }

  let placeholders = (0..song_ids.len())
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(",");
  let sql = format!(
    "DELETE FROM song_prediction_cache WHERE songId IN ({})",
    placeholders
  );

  conn
    .execute(
      &sql,
      rusqlite::params_from_iter(song_ids.iter().map(|s| s.as_str())),
    )
    .map_err(|e| format!("清理 song_prediction_cache 失败: {}", e))
}

pub fn clear_prediction_cache(conn: &Connection) -> Result<usize, String> {
  conn
    .execute("DELETE FROM song_prediction_cache", [])
    .map_err(|e| format!("清理 song_prediction_cache 失败: {}", e))
}

fn parse_f32_le_blob(bytes: &[u8]) -> Result<Vec<f32>, String> {
  if bytes.len() % 4 != 0 {
    return Err("BLOB 长度不是 4 的倍数".to_string());
  }
  let mut out = Vec::with_capacity(bytes.len() / 4);
  for chunk in bytes.chunks_exact(4) {
    out.push(f32::from_le_bytes(
      chunk.try_into().map_err(|_| "字节转换失败")?,
    ));
  }
  Ok(out)
}

fn now_millis_string() -> String {
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  ms.to_string()
}
