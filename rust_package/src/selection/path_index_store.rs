use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const PATH_INDEX_DB_SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone)]
pub struct PathIndexRow {
  pub path_key: String,
  pub file_path: String,
  pub size: i64,
  pub mtime_ms: i64,
  pub song_id: String,
  pub file_hash: String,
  pub updated_at: i64,
  pub last_seen_at: i64,
}

pub fn open_and_migrate(path_index_store_path: &Path) -> Result<Connection, String> {
  if let Some(parent) = path_index_store_path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("创建 path index db 目录失败: {}", e))?;
  }
  let conn = Connection::open(path_index_store_path)
    .map_err(|e| format!("打开 path index db 失败: {}", e))?;
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

      CREATE TABLE IF NOT EXISTS path_song_map (
        pathKey TEXT PRIMARY KEY,
        filePath TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtimeMs INTEGER NOT NULL,
        songId TEXT NOT NULL,
        fileHash TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_path_song_map_songId ON path_song_map(songId);
      CREATE INDEX IF NOT EXISTS idx_path_song_map_lastSeenAt ON path_song_map(lastSeenAt);
      "#,
    )
    .map_err(|e| format!("初始化 path index db schema 失败: {}", e))?;

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
        params![PATH_INDEX_DB_SCHEMA_VERSION.to_string()],
      )
      .map_err(|e| format!("写入 schemaVersion 失败: {}", e))?;
  } else {
    let current: i32 = existing
      .unwrap_or_else(|| "0".to_string())
      .parse()
      .unwrap_or(0);
    if current > PATH_INDEX_DB_SCHEMA_VERSION {
      return Err(format!(
        "path index db schemaVersion 过新：{} > {}",
        current, PATH_INDEX_DB_SCHEMA_VERSION
      ));
    }
  }

  // 确保 lastGcAt 存在（用于 GC 防抖）
  let last_gc: Option<String> = conn
    .query_row(
      "SELECT value FROM schema_meta WHERE key = 'lastGcAt' LIMIT 1",
      [],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 lastGcAt 失败: {}", e))?;
  if last_gc.is_none() {
    conn
      .execute(
        "INSERT INTO schema_meta(key, value) VALUES('lastGcAt', '0')",
        [],
      )
      .map_err(|e| format!("写入 lastGcAt 失败: {}", e))?;
  }

  Ok(())
}

pub fn get_rows_by_path_keys(
  conn: &Connection,
  path_keys: &[String],
) -> Result<Vec<PathIndexRow>, String> {
  if path_keys.is_empty() {
    return Ok(Vec::new());
  }

  let placeholders = (0..path_keys.len())
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(",");

  let sql = format!(
    "SELECT pathKey, filePath, size, mtimeMs, songId, fileHash, updatedAt, lastSeenAt FROM path_song_map WHERE pathKey IN ({})",
    placeholders
  );

  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| format!("准备查询 path_song_map 失败: {}", e))?;

  let rows = stmt
    .query_map(
      rusqlite::params_from_iter(path_keys.iter().map(|s| s.as_str())),
      |row| {
        Ok(PathIndexRow {
          path_key: row.get(0)?,
          file_path: row.get(1)?,
          size: row.get(2)?,
          mtime_ms: row.get(3)?,
          song_id: row.get(4)?,
          file_hash: row.get(5)?,
          updated_at: row.get(6)?,
          last_seen_at: row.get(7)?,
        })
      },
    )
    .map_err(|e| format!("执行查询 path_song_map 失败: {}", e))?;

  let mut out: Vec<PathIndexRow> = Vec::new();
  for r in rows {
    let row = r.map_err(|e| format!("读取 path_song_map 行失败: {}", e))?;
    out.push(row);
  }
  Ok(out)
}

pub fn upsert_rows(conn: &mut Connection, rows: &[PathIndexRow]) -> Result<i64, String> {
  if rows.is_empty() {
    return Ok(0);
  }

  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  let mut affected: i64 = 0;
  {
    let mut stmt = tx
      .prepare(
        r#"
        INSERT INTO path_song_map(pathKey, filePath, size, mtimeMs, songId, fileHash, updatedAt, lastSeenAt)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(pathKey) DO UPDATE SET
          filePath = excluded.filePath,
          size = excluded.size,
          mtimeMs = excluded.mtimeMs,
          songId = excluded.songId,
          fileHash = excluded.fileHash,
          updatedAt = excluded.updatedAt,
          lastSeenAt = excluded.lastSeenAt
        "#,
      )
      .map_err(|e| format!("准备写入 path_song_map 失败: {}", e))?;

    for r in rows {
      affected += stmt
        .execute(params![
          r.path_key.as_str(),
          r.file_path.as_str(),
          r.size,
          r.mtime_ms,
          r.song_id.as_str(),
          r.file_hash.as_str(),
          r.updated_at,
          r.last_seen_at
        ])
        .map_err(|e| format!("写入 path_song_map 失败: {}", e))? as i64;
    }
  }

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(affected)
}

pub fn touch_by_path_keys(
  conn: &mut Connection,
  path_keys: &[String],
  now_ms: i64,
) -> Result<i64, String> {
  if path_keys.is_empty() {
    return Ok(0);
  }

  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  let mut affected: i64 = 0;
  {
    let mut stmt = tx
      .prepare("UPDATE path_song_map SET lastSeenAt = ?1 WHERE pathKey = ?2")
      .map_err(|e| format!("准备更新 lastSeenAt 失败: {}", e))?;

    for k in path_keys {
      affected += stmt
        .execute(params![now_ms, k.as_str()])
        .map_err(|e| format!("更新 lastSeenAt 失败: {}", e))? as i64;
    }
  }

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(affected)
}

pub fn delete_by_path_keys(
  conn: &mut Connection,
  path_keys: &[String],
) -> Result<i64, String> {
  if path_keys.is_empty() {
    return Ok(0);
  }

  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  let mut affected: i64 = 0;
  {
    let mut stmt = tx
      .prepare("DELETE FROM path_song_map WHERE pathKey = ?1")
      .map_err(|e| format!("准备删除 path_song_map 失败: {}", e))?;

    for k in path_keys {
      affected += stmt
        .execute(params![k.as_str()])
        .map_err(|e| format!("删除 path_song_map 失败: {}", e))? as i64;
    }
  }

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
  Ok(affected)
}

fn get_meta_i64(conn: &Connection, key: &str) -> Result<i64, String> {
  let v: Option<String> = conn
    .query_row(
      "SELECT value FROM schema_meta WHERE key = ?1 LIMIT 1",
      params![key],
      |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 schema_meta.{} 失败: {}", key, e))?;
  Ok(v.unwrap_or_else(|| "0".to_string()).parse().unwrap_or(0))
}

fn set_meta_i64(conn: &Connection, key: &str, value: i64) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO schema_meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![key, value.to_string()],
    )
    .map_err(|e| format!("写入 schema_meta.{} 失败: {}", key, e))?;
  Ok(())
}

fn count_rows(conn: &Connection) -> Result<i64, String> {
  let v: i64 = conn
    .query_row("SELECT COUNT(1) FROM path_song_map", [], |row| row.get(0))
    .map_err(|e| format!("统计 path_song_map 失败: {}", e))?;
  Ok(v)
}

pub struct GcResult {
  pub skipped: bool,
  pub before: i64,
  pub after: i64,
  pub deleted_old: i64,
  pub deleted_overflow: i64,
  pub last_gc_at: i64,
}

pub fn gc(
  conn: &mut Connection,
  now_ms: i64,
  min_interval_ms: i64,
  ttl_ms: i64,
  max_rows: i64,
  delete_limit: i64,
) -> Result<GcResult, String> {
  let last_gc_at = get_meta_i64(conn, "lastGcAt")?;
  if now_ms - last_gc_at < min_interval_ms {
    let before = count_rows(conn)?;
    return Ok(GcResult {
      skipped: true,
      before,
      after: before,
      deleted_old: 0,
      deleted_overflow: 0,
      last_gc_at,
    });
  }

  let before = count_rows(conn)?;
  let cutoff = now_ms - ttl_ms;

  let tx = conn
    .transaction()
    .map_err(|e| format!("开启事务失败: {}", e))?;

  // 1) TTL 回收：删除长期未使用的 pathKey
  let deleted_old: i64 = tx
    .execute(
      r#"
      DELETE FROM path_song_map
      WHERE rowid IN (
        SELECT rowid FROM path_song_map
        WHERE lastSeenAt < ?1
        ORDER BY lastSeenAt ASC
        LIMIT ?2
      )
      "#,
      params![cutoff, delete_limit],
    )
    .map_err(|e| format!("执行 TTL 回收失败: {}", e))? as i64;

  // 2) 行数上限回收：超出 max_rows 时继续删除最老的
  let mut deleted_overflow: i64 = 0;
  let mut current = {
    let v: i64 = tx
      .query_row("SELECT COUNT(1) FROM path_song_map", [], |row| row.get(0))
      .map_err(|e| format!("统计 path_song_map 失败: {}", e))?;
    v
  };

  if max_rows > 0 && current > max_rows {
    let overflow = (current - max_rows).min(delete_limit.max(1));
    deleted_overflow = tx
      .execute(
        r#"
        DELETE FROM path_song_map
        WHERE rowid IN (
          SELECT rowid FROM path_song_map
          ORDER BY lastSeenAt ASC
          LIMIT ?1
        )
        "#,
        params![overflow],
      )
      .map_err(|e| format!("执行行数上限回收失败: {}", e))? as i64;

    current -= deleted_overflow;
  }

  set_meta_i64(&tx, "lastGcAt", now_ms)?;

  tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;

  Ok(GcResult {
    skipped: false,
    before,
    after: current,
    deleted_old,
    deleted_overflow,
    last_gc_at: now_ms,
  })
}

pub fn now_millis_i64() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as i64
}
