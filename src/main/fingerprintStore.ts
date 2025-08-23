import fs = require('fs-extra')
import path = require('path')
import os = require('os')
import { v4 as uuidV4 } from 'uuid'
import { getCurrentTimeYYYYMMDDHHMMSSSSS } from './utils'
import store from './store'

// 指纹库版本化存储与读写：
// - 数据文件：songFingerprintV2_YYYYMMDDHHMMSSSSS_UUID.json
// - 指针文件：latest.meta（内容仅一行：当前数据文件名）
// - 修复标记：.fingerprint_healed

const DATA_PREFIX = 'songFingerprintV2_'
const META_FILE = 'latest.meta'
const HEAL_MARK = '.fingerprint_healed'

// 简单串行化队列，确保同一时间仅一次写入
let writeQueue: Promise<any> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  writeQueue = writeQueue.then(task, task)
  return writeQueue
}

function getDir(): string {
  return path.join(store.databaseDir || store.settingConfig?.databaseUrl || '', 'songFingerprint')
}

async function ensureDir(): Promise<string> {
  const dir = getDir()
  await fs.ensureDir(dir)
  return dir
}

function isWindows(): boolean {
  return os.platform() === 'win32'
}

async function isHiddenWindows(filePath: string): Promise<boolean> {
  if (!isWindows()) return false
  const { exec } = require('child_process')
  const { promisify } = require('util')
  const execAsync = promisify(exec)
  try {
    const { stdout } = await execAsync(`attrib "${filePath}"`)
    return /\sH\s/i.test(stdout || '')
  } catch {
    return false
  }
}

async function unhideWindows(filePath: string): Promise<void> {
  if (!isWindows()) return
  const { exec } = require('child_process')
  const { promisify } = require('util')
  const execAsync = promisify(exec)
  // 指数退避：50 → 100 → 200 → 400 → 800ms
  const waits = [50, 100, 200, 400, 800]
  for (let i = 0; i < waits.length; i++) {
    try {
      await execAsync(`attrib -h "${filePath}"`)
      return
    } catch (e) {
      await new Promise((r) => setTimeout(r, waits[i]))
    }
  }
}

function shouldRetry(err: any): boolean {
  const code = String((err && err.code) || '').toUpperCase()
  if (isWindows()) {
    return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'UNKNOWN'
  }
  return code === 'EBUSY' || code === 'EAGAIN' || code === 'UNKNOWN'
}

async function moveWithRetry(src: string, dest: string): Promise<void> {
  const waits = [50, 100, 200, 400, 800]
  let lastErr: any = null
  for (let i = 0; i < waits.length; i++) {
    try {
      await fs.move(src, dest, { overwrite: true })
      return
    } catch (e: any) {
      lastErr = e
      if (!shouldRetry(e)) throw e
      await new Promise((r) => setTimeout(r, waits[i]))
    }
  }
  if (lastErr) throw lastErr
}

async function writeJSONAtomic(destFile: string, data: any): Promise<void> {
  const dir = path.dirname(destFile)
  const tmp = path.join(dir, `${path.basename(destFile)}.tmp`)
  await fs.outputJSON(tmp, data)
  await moveWithRetry(tmp, destFile)
}

async function writeTextAtomic(destFile: string, text: string): Promise<void> {
  const dir = path.dirname(destFile)
  const tmp = path.join(dir, `${path.basename(destFile)}.tmp`)
  await fs.outputFile(tmp, text, 'utf8')
  await moveWithRetry(tmp, destFile)
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

export async function healAndPrepare(): Promise<void> {
  const dir = await ensureDir()
  const mark = path.join(dir, HEAL_MARK)
  if (await fs.pathExists(mark)) return

  // 移除旧版 V1 指纹文件（不再兼容）
  try {
    const v1 = path.join(dir, 'songFingerprint.json')
    if (await fs.pathExists(v1)) {
      await fs.remove(v1)
    }
  } catch {}

  // 若旧文件存在且被隐藏，先去隐藏
  const legacy = path.join(dir, 'songFingerprintV2.json')
  if (await fs.pathExists(legacy)) {
    if (await isHiddenWindows(legacy)) {
      await unhideWindows(legacy)
    }
  }

  // 若无版本文件与指针，则从旧文件或空数组落第一个版本，并建立指针
  const versions = await listVersionFiles(dir)
  const metaPath = path.join(dir, META_FILE)
  if (versions.length === 0 || !(await fs.pathExists(metaPath))) {
    let list: string[] = []
    try {
      if (await fs.pathExists(legacy)) {
        const json = await fs.readJSON(legacy)
        if (Array.isArray(json) && json.every((m: any) => typeof m === 'string')) {
          list = json
        }
      }
    } catch {
      list = []
    }
    const fileName = `${DATA_PREFIX}${getCurrentTimeYYYYMMDDHHMMSSSSS()}_${uuidV4()}.json`
    const dest = path.join(dir, fileName)
    await writeJSONAtomic(dest, list)
    await writeTextAtomic(metaPath, fileName)
  }

  await fs.outputFile(mark, 'ok')
}

export async function loadList(): Promise<string[]> {
  const dir = await ensureDir()
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

async function cleanupOldVersions(dir: string, keep: number = 5): Promise<void> {
  try {
    const candidates = await listVersionFiles(dir)
    if (candidates.length <= keep) return
    // 最新在前，保留前 keep 个
    const withOrder = await Promise.all(
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
    withOrder.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.mtime - a.mtime))
    const toDelete = withOrder.slice(keep).map((x) => path.join(dir, x.name))
    for (const f of toDelete) {
      try {
        await fs.remove(f)
      } catch {
        // 删除失败下次再试，不影响使用
      }
    }
  } catch {
    // 清理失败静默
  }
}

export async function saveList(list: string[]): Promise<void> {
  const dir = await ensureDir()
  return enqueue(async () => {
    const fileName = `${DATA_PREFIX}${getCurrentTimeYYYYMMDDHHMMSSSSS()}_${uuidV4()}.json`
    const dest = path.join(dir, fileName)
    await writeJSONAtomic(dest, Array.from(new Set(list.map((m) => String(m)))))
    await writeTextAtomic(path.join(dir, META_FILE), fileName)
    // 清理旧版本（异步执行，不阻塞）
    cleanupOldVersions(dir, 5).catch(() => {})
  })
}

export async function exportSnapshot(toFilePath: string, list: string[]): Promise<void> {
  await fs.outputJSON(toFilePath, Array.from(new Set(list.map((m) => String(m)))))
}

export async function importFromJsonFile(filePath: string): Promise<string[]> {
  const json: any = await fs.readJSON(filePath)
  if (Array.isArray(json)) {
    const merged = Array.from(new Set([...(store.songFingerprintList || []), ...json]))
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
