import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import child_process from 'node:child_process'
import { log } from '../log'
import store from '../store'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import * as LibraryCacheDb from '../libraryCacheDb'
import { getLibraryDb } from '../libraryDb'
import { listMixtapeFilePathsInUse } from '../mixtapeDb'
import mixtapeWindow from '../window/mixtapeWindow'

// ── 需要预转码的扩展名集合（浏览器无法直接 decodeAudioData 的格式）────
// 与渲染进程 webAudioPlayer.ts 的 FORCE_PCM_EXTENSIONS 保持一致
const NEEDS_TRANSCODE_EXTENSIONS = new Set([
  'm4a',
  'm4b',
  'mp4',
  'mka',
  'webm',
  'alac',
  'ape',
  'tak',
  'tta',
  'wv',
  'dts',
  'ac3',
  'wma',
  'aac'
])

/** 缓存目录名（位于 library root 下） */
const CACHE_DIR_NAME = '.mixtape-transcode-cache'

/** 并发转码上限 */
const MAX_CONCURRENT = 2

/** 正在转码的集合 */
const inflight = new Set<string>()

/** 等待队列 */
const queue: string[] = []

/** 是否已有 drain 循环在运行 */
let draining = false

// ── 工具函数 ──────────────────────────────────────────────────

/** 根据文件路径生成确定性的缓存文件名 */
function toCacheFilename(filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 32)
  return `${hash}.flac`
}

/** 获取缓存目录的绝对路径 */
function getCacheDir(): string {
  return path.join(store.databaseDir, CACHE_DIR_NAME)
}

/** 判断文件扩展名是否需要转码 */
export function needsTranscode(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  return NEEDS_TRANSCODE_EXTENSIONS.has(ext)
}

/** 获取缓存文件的绝对路径 */
export function getTranscodeCachePath(cacheFilename: string): string {
  return path.join(getCacheDir(), cacheFilename)
}

// ── FFmpeg 转码 ──────────────────────────────────────────────

async function transcodeToFlac(srcPath: string, destPath: string): Promise<void> {
  const ffmpegPath = resolveBundledFfmpegPath()
  await ensureExecutableOnMac(ffmpegPath)
  await fs.mkdir(path.dirname(destPath), { recursive: true })

  const args = [
    '-y',
    '-i',
    srcPath,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'flac',
    '-compression_level',
    '0', // 最快压缩，仍无损
    destPath
  ]

  return new Promise<void>((resolve, reject) => {
    const proc = child_process.spawn(ffmpegPath, args, { stdio: 'pipe' })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.slice(-500)}`))
      }
    })
  })
}

// ── 单文件转码流程 ────────────────────────────────────────────

async function processOne(filePath: string): Promise<void> {
  const normalized = filePath.trim()
  if (!normalized || inflight.has(normalized)) return
  inflight.add(normalized)

  try {
    // 1. 检查源文件 stat
    const stat = await fs.stat(normalized).catch(() => null)
    if (!stat || !stat.isFile()) {
      LibraryCacheDb.removeTranscodeCacheEntries([normalized])
      return
    }

    // 2. 检查是否已有有效缓存
    const existing = LibraryCacheDb.loadTranscodeCacheEntry(normalized)
    if (
      existing &&
      existing.transcodeStatus === 'done' &&
      existing.size === stat.size &&
      Math.abs(existing.mtimeMs - stat.mtimeMs) <= 1
    ) {
      // 缓存有效，检查文件是否存在
      const cachePath = getTranscodeCachePath(existing.cacheFilename)
      try {
        await fs.access(cachePath)
        return // 缓存文件存在，跳过
      } catch {
        // 缓存文件丢失，重新转码
      }
    }

    // 3. 执行转码
    const cacheFilename = toCacheFilename(normalized)
    const cachePath = getTranscodeCachePath(cacheFilename)

    LibraryCacheDb.upsertTranscodeCacheEntry(
      normalized,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      cacheFilename,
      'processing'
    )

    await transcodeToFlac(normalized, cachePath)

    // 4. 转码成功，更新状态
    LibraryCacheDb.upsertTranscodeCacheEntry(
      normalized,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      cacheFilename,
      'done'
    )

    // 5. 通知混音窗口缓存就绪
    try {
      mixtapeWindow.broadcast?.('mixtape-transcode-ready', { filePath: normalized })
    } catch {}

    log.info('[混音转码] 完成', { filePath: normalized, cacheFilename })
  } catch (error) {
    log.error('[混音转码] 失败', { filePath: normalized, error })
    LibraryCacheDb.updateTranscodeCacheStatus(normalized, 'failed')
  } finally {
    inflight.delete(normalized)
  }
}

// ── 排水循环 ──────────────────────────────────────────────────

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      // 等待并发槽位
      while (inflight.size >= MAX_CONCURRENT) {
        await new Promise((r) => setTimeout(r, 200))
      }
      const next = queue.shift()
      if (!next) break
      // 不 await，让多个并发执行
      void processOne(next).then(() => {
        // 继续尝试排水
        if (queue.length > 0 && inflight.size < MAX_CONCURRENT) {
          void drain()
        }
      })
    }
  } finally {
    draining = false
  }
}

// ── 公共 API ─────────────────────────────────────────────────

/**
 * 将文件路径加入转码队列
 * 自动过滤：只处理需要转码的格式，跳过已在队列或正在转码的
 */
export function queueMixtapeTranscode(filePaths: string[]): void {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  for (const raw of filePaths) {
    const filePath = (raw || '').trim()
    if (!filePath) continue
    if (!needsTranscode(filePath)) continue
    if (inflight.has(filePath)) continue
    if (queue.includes(filePath)) continue
    queue.push(filePath)
  }
  void drain()
}

/**
 * 清理转码缓存（移除轨道/歌单时调用）
 * 只删除不再被任何混音歌单引用的文件缓存
 */
export async function cleanupMixtapeTranscodeCache(filePaths: string[]): Promise<void> {
  const normalizedPaths = Array.from(
    new Set(
      filePaths
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
    )
  )
  if (normalizedPaths.length === 0) return

  // 检查哪些路径仍被其他歌单引用
  const inUse = new Set(listMixtapeFilePathsInUse(normalizedPaths))
  const unused = normalizedPaths.filter((fp) => !inUse.has(fp))
  if (unused.length === 0) return

  // 收集需要删除的缓存文件
  const cacheDir = getCacheDir()
  for (const filePath of unused) {
    const entry = LibraryCacheDb.loadTranscodeCacheEntry(filePath)
    if (entry?.cacheFilename) {
      const cachePath = path.join(cacheDir, entry.cacheFilename)
      try {
        await fs.unlink(cachePath)
      } catch {}
    }
  }

  // 删除 SQLite 记录
  LibraryCacheDb.removeTranscodeCacheEntries(unused)
}

/**
 * 定期维护：扫描缓存目录，删除无主文件
 */
export async function pruneOrphanedTranscodeCache(): Promise<number> {
  const cacheDir = getCacheDir()
  try {
    await fs.access(cacheDir)
  } catch {
    return 0
  }

  // 获取 DB 中所有有效缓存文件名
  const validFilenames = new Set(LibraryCacheDb.listAllTranscodeCacheFilenames())

  let removed = 0
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!validFilenames.has(entry.name)) {
        try {
          await fs.unlink(path.join(cacheDir, entry.name))
          removed += 1
        } catch {}
      }
    }
  } catch (error) {
    log.error('[混音转码] 清理孤立缓存失败', error)
  }
  return removed
}

// ── 闲时后台扫描 ─────────────────────────────────────────────

/** 闲时扫描间隔（毫秒） */
const BACKGROUND_SCAN_INTERVAL_MS = 60_000
/** 初次启动延迟（毫秒），等应用充分加载后再启动 */
const BACKGROUND_INITIAL_DELAY_MS = 30_000

let backgroundTimer: ReturnType<typeof setTimeout> | null = null
let backgroundEnabled = false

/**
 * 闲时后台扫描：查找所有混音歌单中需要转码但尚未完成的文件，加入队列
 */
async function runBackgroundTranscodeScan(): Promise<void> {
  if (!backgroundEnabled) return
  const db = getLibraryDb()
  if (!db) return

  try {
    // 从 mixtape_items 中找出所有去重的 file_path
    const rows = db.prepare('SELECT DISTINCT file_path FROM mixtape_items').all() as Array<{
      file_path: string
    }>
    const allPaths = rows.map((r) => r.file_path).filter(Boolean)
    if (allPaths.length === 0) return

    // 过滤出需要转码的
    const needsPaths = allPaths.filter(needsTranscode)
    if (needsPaths.length === 0) return

    // 查询已完成缓存
    const cacheMap = LibraryCacheDb.loadTranscodeCacheBatch(needsPaths)
    const uncached = needsPaths.filter((fp) => !cacheMap.has(fp))
    if (uncached.length === 0) {
      // 所有都已缓存，趁机清理孤立文件
      await pruneOrphanedTranscodeCache()
      return
    }

    // 加入队列（queueMixtapeTranscode 内部会去重）
    queueMixtapeTranscode(uncached)
    log.info('[混音转码] 闲时扫描入队', { total: uncached.length })
  } catch (error) {
    log.error('[混音转码] 闲时扫描失败', error)
  }
}

function scheduleNextScan(): void {
  if (!backgroundEnabled) return
  if (backgroundTimer) return
  backgroundTimer = setTimeout(() => {
    backgroundTimer = null
    void runBackgroundTranscodeScan().finally(() => {
      if (backgroundEnabled) scheduleNextScan()
    })
  }, BACKGROUND_SCAN_INTERVAL_MS)
}

/**
 * 启动闲时转码后台扫描
 * 应在应用初始化完成后调用一次
 */
export function startMixtapeTranscodeBackground(): void {
  if (backgroundEnabled) return
  backgroundEnabled = true
  // 延迟启动，避免与应用初始化争资源
  setTimeout(() => {
    if (backgroundEnabled) {
      void runBackgroundTranscodeScan().finally(() => scheduleNextScan())
    }
  }, BACKGROUND_INITIAL_DELAY_MS)
}

/**
 * 停止闲时转码后台扫描
 */
export function stopMixtapeTranscodeBackground(): void {
  backgroundEnabled = false
  if (backgroundTimer) {
    clearTimeout(backgroundTimer)
    backgroundTimer = null
  }
}
