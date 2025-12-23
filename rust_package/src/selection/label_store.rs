use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const LABEL_DB_SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionLabel {
  Liked,
  Disliked,
  Neutral,
}

impl SelectionLabel {
  pub fn parse(s: &str) -> Option<Self> {
    match s.trim() {
      "liked" => Some(SelectionLabel::Liked),
      "disliked" => Some(SelectionLabel::Disliked),
      "neutral" => Some(SelectionLabel::Neutral),
      _ => None,
    }
  }

  pub fn as_str(&self) -> &'static str {
    match self {
      SelectionLabel::Liked => "liked",
      SelectionLabel::Disliked => "disliked",
      SelectionLabel::Neutral => "neutral",
    }
  }
}

pub fn open_and_migrate(label_store_path: &Path) -> Result<Connection, String> {
  if let Some(parent) = label_store_path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("创建 labels db 目录失败: {}", e))?;
  }
  let conn =
    Connection::open(label_store_path).map_err(|e| format!("打开 labels db 失败: {}", e))?;
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

      CREATE TABLE IF NOT EXISTS song_labels (
        songId TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_song_labels_label ON song_labels(label);
      "#,
    )
    .map_err(|e| format!("初始化 labels db schema 失败: {}", e))?;

  let existing: Option<String> = conn
    .query_row(
      "SELECT value FROM schema_meta WHERE key = 'schemaVersion' LIMIT 1",
      [],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 schemaVersion 失败: {}", e))?;

  if existing.is_none() {
    conn
      .execute(
        "INSERT INTO schema_meta(key, value) VALUES('schemaVersion', ?1)",
        params![LABEL_DB_SCHEMA_VERSION.to_string()],
      )
      .map_err(|e| format!("写入 schemaVersion 失败: {}", e))?;
  } else {
    let current: i32 = existing
      .unwrap_or_else(|| "0".to_string())
      .parse()
      .unwrap_or(0);
    if current > LABEL_DB_SCHEMA_VERSION {
      return Err(format!(
        "labels db schemaVersion 过新：{} > {}",
        current, LABEL_DB_SCHEMA_VERSION
      ));
    }
  }

  // 确保 sampleChangeCount 存在
  let scc: Option<String> = conn
    .query_row(
      "SELECT value FROM schema_meta WHERE key = 'sampleChangeCount' LIMIT 1",
      [],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 sampleChangeCount 失败: {}", e))?;
  if scc.is_none() {
    conn
      .execute(
        "INSERT INTO schema_meta(key, value) VALUES('sampleChangeCount', '0')",
        [],
      )
      .map_err(|e| format!("写入 sampleChangeCount 失败: {}", e))?;
  }

  Ok(())
}

pub fn get_sample_change_count(conn: &Connection) -> Result<i64, String> {
  let v: Option<String> = conn
    .query_row(
      "SELECT value FROM schema_meta WHERE key = 'sampleChangeCount' LIMIT 1",
      [],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 sampleChangeCount 失败: {}", e))?;
  Ok(v.unwrap_or_else(|| "0".to_string()).parse().unwrap_or(0))
}

pub fn set_sample_change_count(conn: &Connection, value: i64) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO schema_meta(key, value) VALUES('sampleChangeCount', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![value.to_string()],
    )
    .map_err(|e| format!("写入 sampleChangeCount 失败: {}", e))?;
  Ok(())
}

pub fn bump_sample_change_count(conn: &mut Connection, delta: i64) -> Result<i64, String> {
  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  let old_count = get_sample_change_count(&tx)?;
  let new_count = (old_count + delta).max(0);
  set_sample_change_count(&tx, new_count)?;

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(new_count)
}

pub fn get_label_for_song_id(conn: &Connection, song_id: &str) -> Result<SelectionLabel, String> {
  let v: Option<String> = conn
    .query_row(
      "SELECT label FROM song_labels WHERE songId = ?1 LIMIT 1",
      params![song_id],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 song_labels 失败: {}", e))?;

  Ok(v
    .as_deref()
    .and_then(SelectionLabel::parse)
    .unwrap_or(SelectionLabel::Neutral))
}

pub fn get_label_snapshot(conn: &Connection) -> Result<(Vec<String>, Vec<String>), String> {
  let mut positives: Vec<String> = Vec::new();
  let mut negatives: Vec<String> = Vec::new();

  let mut stmt = conn
    .prepare("SELECT songId, label FROM song_labels")
    .map_err(|e| format!("准备查询 song_labels 失败: {}", e))?;
  let rows = stmt
    .query_map([], |row| {
      let id: String = row.get(0)?;
      let label: String = row.get(1)?;
      Ok((id, label))
    })
    .map_err(|e| format!("执行查询 song_labels 失败: {}", e))?;

  for r in rows {
    let (id, label) = r.map_err(|e| format!("读取 song_labels 行失败: {}", e))?;
    match label.as_str() {
      "liked" => positives.push(id),
      "disliked" => negatives.push(id),
      _ => {}
    }
  }
  positives.sort();
  negatives.sort();
  Ok((positives, negatives))
}

pub fn reset_all(conn: &mut Connection) -> Result<(), String> {
  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;
  {
    tx.execute("DELETE FROM song_labels", [])
      .map_err(|e| format!("清空 song_labels 失败: {}", e))?;
    tx.execute(
      "INSERT INTO schema_meta(key, value) VALUES('sampleChangeCount', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [],
    )
    .map_err(|e| format!("重置 sampleChangeCount 失败: {}", e))?;
  }
  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(())
}

pub fn set_labels_bulk(
  conn: &mut Connection,
  song_ids: Vec<String>,
  label: SelectionLabel,
) -> Result<(i32, i32, i64), String> {
  let mut unique: HashSet<String> = song_ids
    .into_iter()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
  if unique.is_empty() {
    let current = get_sample_change_count(conn)?;
    return Ok((0, 0, current));
  }
  let mut ids: Vec<String> = unique.drain().collect();
  ids.sort();

  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  let existing_map = load_existing_labels(&tx, &ids)?;
  let mut delta: i32 = 0;
  let now = now_millis_string();

  {
    let mut upsert_stmt = tx
      .prepare(
        r#"
        INSERT INTO song_labels(songId, label, updatedAt)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(songId) DO UPDATE SET
          label = excluded.label,
          updatedAt = excluded.updatedAt
        "#,
      )
      .map_err(|e| format!("准备写入 song_labels 失败: {}", e))?;

    let mut delete_stmt = tx
      .prepare("DELETE FROM song_labels WHERE songId = ?1")
      .map_err(|e| format!("准备删除 song_labels 失败: {}", e))?;

    for id in &ids {
      let old = existing_map
        .get(id)
        .and_then(|s| SelectionLabel::parse(s))
        .unwrap_or(SelectionLabel::Neutral);

      if old == label {
        continue;
      }

      if label == SelectionLabel::Neutral {
        // neutral 视作默认态：删除记录即可
        delete_stmt
          .execute(params![id.as_str()])
          .map_err(|e| format!("删除 song_labels 失败: {}", e))?;
      } else {
        upsert_stmt
          .execute(params![id.as_str(), label.as_str(), now.as_str()])
          .map_err(|e| format!("写入 song_labels 失败: {}", e))?;
      }
      delta += 1;
    }
  }

  let old_count = get_sample_change_count(&tx)?;
  let new_count = old_count + delta as i64;
  set_sample_change_count(&tx, new_count)?;

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;

  Ok((ids.len() as i32, delta, new_count))
}

fn load_existing_labels(
  conn: &Connection,
  song_ids: &[String],
) -> Result<HashMap<String, String>, String> {
  let mut map = HashMap::new();
  if song_ids.is_empty() {
    return Ok(map);
  }
  let placeholders = (0..song_ids.len())
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(",");
  let sql = format!(
    "SELECT songId, label FROM song_labels WHERE songId IN ({})",
    placeholders
  );
  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| format!("准备查询 song_labels 失败: {}", e))?;
  let rows = stmt
    .query_map(rusqlite::params_from_iter(song_ids.iter().map(|s| s.as_str())), |row| {
      let id: String = row.get(0)?;
      let label: String = row.get(1)?;
      Ok((id, label))
    })
    .map_err(|e| format!("执行查询 song_labels 失败: {}", e))?;
  for r in rows {
    let (id, label) = r.map_err(|e| format!("读取 song_labels 行失败: {}", e))?;
    map.insert(id, label);
  }
  Ok(map)
}

fn now_millis_string() -> String {
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  ms.to_string()
}
