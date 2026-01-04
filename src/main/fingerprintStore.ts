import fs = require('fs-extra')
import path = require('path')
import store from './store'
import { getLibraryDb, getMetaValue, setMetaValue } from './libraryDb'
import { log } from './log'

// 旧版指纹文件仅用于迁移读取：
// - 数据文件：songFingerprintV2_YYYYMMDDHHMMSSSSS_UUID.json
// - 指针文件：latest.meta（内容仅一行：当前数据文件名）

const DATA_PREFIX = 'songFingerprintV2_'
const META_FILE = 'latest.meta'

type FingerprintMode = 'pcm' | 'file'

const MIGRATION_META_PREFIX = 'fingerprints_migrated_'

function resolveMode(mode?: FingerprintMode): FingerprintMode {
  return mode === 'file' ? 'file' : 'pcm'
}

function normalizeList(list: string[]): string[] {
  return Array.from(new Set(list.map((m) => String(m))))
}

function getMigrationKey(mode: FingerprintMode): string {
  return `${MIGRATION_META_PREFIX}${mode}`
}

// 简单串行化队列，确保同一时间仅一次写入
let writeQueue: Promise<any> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  writeQueue = writeQueue.then(task, task)
  return writeQueue
}

function getDir(mode?: FingerprintMode): string {
  const root = store.databaseDir || store.settingConfig?.databaseUrl || ''
  if (!root) return ''
  const base = path.join(root, 'songFingerprint')
  const sub = mode === 'file' ? 'file' : 'pcm'
  return path.join(base, sub)
}

async function listVersionFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [])
  return names.filter((n) => n.startsWith(DATA_PREFIX) && n.endsWith('.json'))
}

async function selectLatestFile(dir: string, candidates: string[]): Promise<string | null> {
  if (candidates.length === 0) return null
  // 优先按文件名（时间戳前缀）排序，降序；相同则按 mtime 降序
  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const full = path.join(dir, name)
      let mtime = 0
      try {
        const st = await fs.stat(full)
        mtime = st.mtimeMs || 0
      } catch {
        mtime = 0
      }
      return { name, mtime }
    })
  )
  withStats.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.mtime - a.mtime))
  return withStats[0]?.name || null
}

function toStringArray(value: any): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string').map((item) => String(item))
}

async function readJsonArrayIfExists(filePath: string): Promise<string[]> {
  try {
    if (await fs.pathExists(filePath)) {
      const json = await fs.readJSON(filePath)
      return toStringArray(json)
    }
  } catch {}
  return []
}

async function loadLegacyRootList(baseDir: string): Promise<string[]> {
  const collected: string[] = []
  const v1 = await readJsonArrayIfExists(path.join(baseDir, 'songFingerprint.json'))
  const v2 = await readJsonArrayIfExists(path.join(baseDir, 'songFingerprintV2.json'))
  collected.push(...v1, ...v2)
  const candidates = await listVersionFiles(baseDir)
  if (candidates.length > 0) {
    const latest = await selectLatestFile(baseDir, candidates)
    if (latest) {
      const json = await readJsonArrayIfExists(path.join(baseDir, latest))
      collected.push(...json)
    }
  }
  return normalizeList(collected)
}

function readListFromDb(db: any, mode: FingerprintMode): string[] {
  const rows = db.prepare('SELECT hash FROM fingerprints WHERE mode = ?').all(mode)
  return rows.map((row: any) => String(row.hash))
}

function writeListToDb(db: any, mode: FingerprintMode, list: string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO fingerprints (mode, hash) VALUES (?, ?)')
  const wipe = db.prepare('DELETE FROM fingerprints WHERE mode = ?')
  const run = db.transaction((items: string[]) => {
    wipe.run(mode)
    for (const hash of items) {
      insert.run(mode, hash)
    }
  })
  run(list)
}

async function loadListFromFiles(mode?: FingerprintMode): Promise<string[]> {
  const dir = getDir(mode)
  if (!dir) return []
  try {
    if (!(await fs.pathExists(dir))) return []
  } catch {
    return []
  }
  const metaPath = path.join(dir, META_FILE)
  try {
    if (await fs.pathExists(metaPath)) {
      const fileName = String(await fs.readFile(metaPath, 'utf8')).trim()
      const target = path.join(dir, fileName)
      if (await fs.pathExists(target)) {
        const json = await fs.readJSON(target)
        if (Array.isArray(json)) return json
      }
    }
  } catch {}
  const candidates = await listVersionFiles(dir)
  const latest = await selectLatestFile(dir, candidates)
  if (latest) {
    try {
      const json = await fs.readJSON(path.join(dir, latest))
      if (Array.isArray(json)) return json
    } catch {}
  }
  return []
}

async function migrateLegacyIfNeeded(
  db: any,
  mode: FingerprintMode,
  fallbackList?: string[]
): Promise<void> {
  const key = getMigrationKey(mode)
  const migrated = getMetaValue(db, key)
  if (migrated === '1') return
  const existing = readListFromDb(db, mode)
  if (existing.length > 0) {
    setMetaValue(db, key, '1')
    return
  }
  let legacy = await loadListFromFiles(mode)
  if (fallbackList && fallbackList.length > 0) {
    legacy = normalizeList([...legacy, ...fallbackList])
  }
  if (legacy.length > 0) {
    writeListToDb(db, mode, normalizeList(legacy))
  }
  setMetaValue(db, key, '1')
}

export async function healAndPrepare(): Promise<void> {
  const root = store.databaseDir || store.settingConfig?.databaseUrl || ''
  if (!root) return
  const base = path.join(root, 'songFingerprint')
  let legacyRootList: string[] = []
  try {
    if (await fs.pathExists(base)) {
      legacyRootList = await loadLegacyRootList(base)
    }
  } catch {}

  const db = getLibraryDb()
  if (!db) {
    log.error('[fingerprint] sqlite not available, skip migration')
    return
  }
  try {
    await migrateLegacyIfNeeded(db, 'pcm', legacyRootList)
    await migrateLegacyIfNeeded(db, 'file')
  } catch (error) {
    log.error('[fingerprint] sqlite migration failed', error)
  }
  try {
    if (await fs.pathExists(base)) {
      await fs.remove(base)
    }
  } catch {}
}

export async function loadList(mode?: FingerprintMode): Promise<string[]> {
  const resolvedMode = resolveMode(mode)
  const db = getLibraryDb()
  if (!db) {
    log.error('[fingerprint] sqlite not available, load skipped')
    return []
  }
  try {
    await migrateLegacyIfNeeded(db, resolvedMode)
    return readListFromDb(db, resolvedMode)
  } catch (error) {
    log.error('[fingerprint] sqlite load failed', error)
  }
  return []
}

export async function saveList(list: string[], mode?: FingerprintMode): Promise<void> {
  const resolvedMode = resolveMode(mode)
  return enqueue(async () => {
    const normalized = normalizeList(list)
    const db = getLibraryDb()
    if (!db) {
      log.error('[fingerprint] sqlite not available, save skipped')
      return
    }
    try {
      writeListToDb(db, resolvedMode, normalized)
      setMetaValue(db, getMigrationKey(resolvedMode), '1')
      return
    } catch (error) {
      log.error('[fingerprint] sqlite save failed', error)
    }
  })
}

export async function exportSnapshot(toFilePath: string, list: string[]): Promise<void> {
  await fs.outputJSON(toFilePath, normalizeList(list))
}

export async function importFromJsonFile(filePath: string): Promise<string[]> {
  const json: any = await fs.readJSON(filePath)
  if (Array.isArray(json)) {
    const merged = normalizeList([...(store.songFingerprintList || []), ...json])
    await saveList(merged)
    return merged
  }
  return store.songFingerprintList || []
}

export default {
  healAndPrepare,
  loadList,
  saveList,
  exportSnapshot,
  importFromJsonFile
}
