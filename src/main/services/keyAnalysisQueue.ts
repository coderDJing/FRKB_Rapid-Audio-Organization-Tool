import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import * as LibraryCacheDb from '../libraryCacheDb'
import { getLibraryDb } from '../libraryDb'
import store from '../store'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import type { ISongInfo } from '../../types/globals'
import type { MixxxWaveformData } from '../waveformCache'
import { log } from '../log'

type KeyAnalysisPriority = 'high' | 'medium' | 'low' | 'background'
type KeyAnalysisSource = 'foreground' | 'background'

type KeyAnalysisJob = {
  jobId: number
  filePath: string
  normalizedPath: string
  priority: KeyAnalysisPriority
  fastAnalysis: boolean
  source: KeyAnalysisSource
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
}

type KeyAnalysisResult = {
  filePath: string
  keyText: string
}

type BpmAnalysisResult = {
  filePath: string
  bpm: number
}

type DoneEntry = {
  size: number
  mtimeMs: number
  keyText?: string
  bpm?: number
  hasWaveform?: boolean
}

type WorkerPayload = {
  jobId: number
  filePath: string
  result?: {
    keyText?: string
    keyError?: string
    bpm?: number
    bpmError?: string
    mixxxWaveformData?: MixxxWaveformData | null
  }
  error?: string
}

type BackgroundDirItem = {
  dir: string
  listRoot: string
}

type DirHandle = Awaited<ReturnType<typeof fs.opendir>>

const normalizePath = (value: string): string => {
  let normalized = path.normalize(value || '')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

const isValidKeyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isValidBpm = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const BACKGROUND_IDLE_DELAY_MS = 3000
const BACKGROUND_SCAN_COOLDOWN_MS = 5000
const BACKGROUND_SCAN_ROW_LIMIT = 200
const BACKGROUND_BATCH_SIZE = 1
const BACKGROUND_MAX_INFLIGHT = 1
const BACKGROUND_FS_REFRESH_MS = 60000
const BACKGROUND_FS_DIR_LIMIT = 3
const BACKGROUND_FS_ENTRY_LIMIT = 200
const BACKGROUND_CLEAN_ROW_LIMIT = 200
const BACKGROUND_CLEAN_BATCH_SIZE = 20

class KeyAnalysisQueue {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private pendingHigh: KeyAnalysisJob[] = []
  private pendingMedium: KeyAnalysisJob[] = []
  private pendingLow: KeyAnalysisJob[] = []
  private pendingBackground: KeyAnalysisJob[] = []
  private pendingByPath = new Map<string, KeyAnalysisJob>()
  private activeByPath = new Map<string, KeyAnalysisJob>()
  private busy = new Map<Worker, number>()
  private inFlight = new Map<number, KeyAnalysisJob>()
  private preemptedJobIds = new Set<number>()
  private doneByPath = new Map<string, DoneEntry>()
  private nextJobId = 0
  private events: EventEmitter
  private lastForegroundAt = 0
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null
  private backgroundScanInProgress = false
  private backgroundCursor = 0
  private backgroundLastScanAt = 0
  private backgroundRoots: string[] = []
  private backgroundRootsSignature = ''
  private backgroundRootIndex = 0
  private backgroundDirQueue: BackgroundDirItem[] = []
  private backgroundRootsLastRefresh = 0
  private backgroundCleanCursor = 0

  constructor(workerCount: number, events: EventEmitter) {
    const count = Math.max(1, workerCount)
    this.events = events
    for (let i = 0; i < count; i += 1) {
      this.workers.push(this.createWorker())
    }
  }

  startBackgroundSweep() {
    if (this.backgroundTimer) return
    if (this.isIdle()) {
      this.scheduleBackgroundScan()
    }
  }

  enqueue(
    filePath: string,
    priority: KeyAnalysisPriority,
    options: { urgent?: boolean; source?: KeyAnalysisSource; fastAnalysis?: boolean } = {}
  ) {
    if (!filePath) return
    this.clearBackgroundTimer()
    const normalizedPath = normalizePath(filePath)
    const source = options.source || (priority === 'background' ? 'background' : 'foreground')
    if (source === 'foreground') {
      this.lastForegroundAt = Date.now()
    }
    if (this.activeByPath.has(normalizedPath)) return
    const existing = this.pendingByPath.get(normalizedPath)
    if (existing) {
      if (this.isHigherPriority(priority, existing.priority)) {
        this.removePending(existing)
        existing.priority = priority
        existing.source = source
        if (options.fastAnalysis !== undefined) {
          existing.fastAnalysis = options.fastAnalysis
        }
        this.addPending(existing, options.urgent)
      }
      if (options.urgent && existing.priority === 'high') {
        this.removePending(existing)
        this.addPending(existing, true)
      }
      return
    }

    const job: KeyAnalysisJob = {
      jobId: ++this.nextJobId,
      filePath,
      normalizedPath,
      priority,
      fastAnalysis: options.fastAnalysis ?? true,
      source
    }
    this.addPending(job, options.urgent)
    if (source === 'foreground') {
      this.maybePreemptBackground()
    }
    this.drain()
  }

  enqueueList(
    filePaths: string[],
    priority: KeyAnalysisPriority,
    options: { urgent?: boolean; source?: KeyAnalysisSource; fastAnalysis?: boolean } = {}
  ) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      this.enqueue(filePath, priority, options)
    }
  }

  private isHigherPriority(next: KeyAnalysisPriority, current: KeyAnalysisPriority): boolean {
    const rank = { high: 4, medium: 3, low: 2, background: 1 }
    return rank[next] > rank[current]
  }

  private addPending(job: KeyAnalysisJob, urgent?: boolean) {
    this.pendingByPath.set(job.normalizedPath, job)
    if (job.priority === 'high') {
      if (urgent) {
        this.pendingHigh.unshift(job)
      } else {
        this.pendingHigh.push(job)
      }
    } else if (job.priority === 'medium') {
      this.pendingMedium.push(job)
    } else if (job.priority === 'low') {
      this.pendingLow.push(job)
    } else {
      this.pendingBackground.push(job)
    }
  }

  private removePending(job: KeyAnalysisJob) {
    const removeFrom = (queue: KeyAnalysisJob[]) => {
      const idx = queue.findIndex((item) => item.normalizedPath === job.normalizedPath)
      if (idx !== -1) queue.splice(idx, 1)
    }
    removeFrom(this.pendingHigh)
    removeFrom(this.pendingMedium)
    removeFrom(this.pendingLow)
    removeFrom(this.pendingBackground)
    this.pendingByPath.delete(job.normalizedPath)
  }

  private popNextJob(): KeyAnalysisJob | null {
    const job =
      this.pendingHigh.shift() ||
      this.pendingMedium.shift() ||
      this.pendingLow.shift() ||
      this.pendingBackground.shift()
    if (!job) return null
    this.pendingByPath.delete(job.normalizedPath)
    return job
  }

  private createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workers', 'keyAnalysisWorker.js')
    const worker = new Worker(workerPath)

    worker.on('message', (payload: WorkerPayload) => {
      this.handleWorkerMessage(worker, payload)
    })

    worker.on('error', (error) => {
      this.handleWorkerFailure(worker, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.handleWorkerFailure(worker, new Error(`worker exited: ${code}`))
      }
    })

    this.idle.push(worker)
    return worker
  }

  private handleWorkerFailure(worker: Worker, _error: Error) {
    const jobId = this.busy.get(worker)
    let preemptedJob: KeyAnalysisJob | null = null
    if (jobId) {
      const job = this.inFlight.get(jobId)
      if (job) {
        this.activeByPath.delete(job.normalizedPath)
        this.inFlight.delete(jobId)
      }
      if (job && this.preemptedJobIds.has(jobId)) {
        this.preemptedJobIds.delete(jobId)
        preemptedJob = job
      }
      this.busy.delete(worker)
    }

    this.workers = this.workers.filter((item) => item !== worker)
    this.idle = this.idle.filter((item) => item !== worker)

    const replacement = this.createWorker()
    this.workers.push(replacement)
    this.drain()
    if (preemptedJob) {
      this.enqueue(preemptedJob.filePath, 'background', { source: 'background' })
    }
  }

  private async handleWorkerMessage(worker: Worker, payload: WorkerPayload) {
    const jobId = payload?.jobId
    const job = this.inFlight.get(jobId)
    const payloadResult = payload?.result
    const payloadError = payload?.error

    if (typeof jobId === 'number') {
      this.preemptedJobIds.delete(jobId)
    }
    this.inFlight.delete(jobId)
    this.busy.delete(worker)
    this.idle.push(worker)
    if (job) {
      this.activeByPath.delete(job.normalizedPath)
    }

    if (job && payloadResult && !payloadResult.keyError) {
      const keyText = payloadResult.keyText
      if (isValidKeyText(keyText)) {
        await this.persistKey(job.filePath, keyText)
      }
    }

    if (job && payloadResult && !payloadResult.bpmError) {
      const bpmValue = payloadResult.bpm
      if (isValidBpm(bpmValue)) {
        await this.persistBpm(job.filePath, bpmValue)
      }
    }

    if (job && payloadResult?.mixxxWaveformData && job.needsWaveform) {
      await this.persistWaveform(job.filePath, payloadResult.mixxxWaveformData)
      this.events.emit('waveform-updated', { filePath: job.filePath })
    }

    if (job) {
      const waveformStatus = (() => {
        if (!job.needsWaveform) return 'skip'
        if (payloadError) return 'failed'
        if (payloadResult?.mixxxWaveformData) return 'computed'
        return 'missing'
      })()
      if (payloadError) {
        log.warn('[key-analysis] failed', {
          filePath: job.filePath,
          priority: job.priority,
          source: job.source,
          waveform: waveformStatus,
          error: payloadError
        })
      } else {
        const keyText = payloadResult?.keyText
        const bpmValue = payloadResult?.bpm
        log.info('[key-analysis] done', {
          filePath: job.filePath,
          priority: job.priority,
          source: job.source,
          keyText: isValidKeyText(keyText) ? keyText : null,
          bpm: isValidBpm(bpmValue) ? Number(bpmValue.toFixed(2)) : null,
          waveform: waveformStatus,
          keyError: payloadResult?.keyError,
          bpmError: payloadResult?.bpmError
        })
      }
    }

    this.drain()
  }

  private async persistKey(filePath: string, keyText: string) {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      const existing = this.doneByPath.get(normalizedPath)
      this.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText,
        bpm: existing?.bpm,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const updated = await LibraryCacheDb.updateSongCacheKey(listRoot, filePath, keyText)
        if (!updated) {
          await this.ensureSongCacheEntry(
            listRoot,
            filePath,
            { keyText },
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
      }

      const payload: KeyAnalysisResult = { filePath, keyText }
      this.events.emit('key-updated', payload)
    } catch {
      const existing = this.doneByPath.get(normalizedPath)
      this.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText,
        bpm: existing?.bpm,
        hasWaveform: existing?.hasWaveform
      })
      const payload: KeyAnalysisResult = { filePath, keyText }
      this.events.emit('key-updated', payload)
    }
  }

  private async persistBpm(filePath: string, bpm: number) {
    const normalizedPath = normalizePath(filePath)
    const normalizedBpm = Number(bpm.toFixed(2))
    try {
      const stat = await fs.stat(filePath)
      const existing = this.doneByPath.get(normalizedPath)
      this.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        bpm: normalizedBpm,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const updated = await LibraryCacheDb.updateSongCacheBpm(listRoot, filePath, normalizedBpm)
        if (!updated) {
          await this.ensureSongCacheEntry(
            listRoot,
            filePath,
            { bpm: normalizedBpm },
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
      }

      const payload: BpmAnalysisResult = { filePath, bpm: normalizedBpm }
      this.events.emit('bpm-updated', payload)
    } catch {
      const existing = this.doneByPath.get(normalizedPath)
      this.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        bpm: normalizedBpm,
        hasWaveform: existing?.hasWaveform
      })
      const payload: BpmAnalysisResult = { filePath, bpm: normalizedBpm }
      this.events.emit('bpm-updated', payload)
    }
  }

  private async persistWaveform(filePath: string, waveformData: MixxxWaveformData) {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      const existing = this.doneByPath.get(normalizedPath)
      this.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        bpm: existing?.bpm,
        hasWaveform: true
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        if (!cached) {
          await this.ensureSongCacheEntry(
            listRoot,
            filePath,
            {},
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
        await LibraryCacheDb.upsertWaveformCacheEntry(
          listRoot,
          filePath,
          { size: stat.size, mtimeMs: stat.mtimeMs },
          waveformData
        )
      }
    } catch {
      const existing = this.doneByPath.get(normalizedPath)
      this.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        bpm: existing?.bpm,
        hasWaveform: true
      })
    }
  }

  private async ensureSongCacheEntry(
    listRoot: string,
    filePath: string,
    payload: { keyText?: string; bpm?: number },
    stat?: { size: number; mtimeMs: number }
  ) {
    if (!listRoot || !filePath) return
    let fileStat = stat
    if (!fileStat) {
      try {
        const fsStat = await fs.stat(filePath)
        fileStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
      } catch {
        return
      }
    }
    let entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
    let info: ISongInfo
    if (entry && entry.info) {
      info = { ...entry.info }
    } else {
      info = buildLiteSongInfo(filePath)
    }
    info = applyLiteDefaults(info, filePath)
    const markAnalysisOnly = !entry || Boolean(entry.info?.analysisOnly)
    if (markAnalysisOnly) {
      info.analysisOnly = true
    }
    if (payload.keyText) {
      info.key = payload.keyText
    }
    if (payload.bpm !== undefined) {
      info.bpm = payload.bpm
    }
    await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      info
    })
  }

  private async prepareJob(job: KeyAnalysisJob): Promise<boolean> {
    const filePath = job.filePath
    let stat: { size: number; mtimeMs: number }
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      await this.handleMissingFile(job.filePath)
      return false
    }

    let needsKey = true
    let needsBpm = true
    let needsWaveform = true
    const done = this.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      if (isValidKeyText(done.keyText)) {
        needsKey = false
      }
      if (isValidBpm(done.bpm)) {
        needsBpm = false
      }
      if (done.hasWaveform) {
        needsWaveform = false
      }
      if (!needsKey && !needsBpm && !needsWaveform) {
        job.needsKey = false
        job.needsBpm = false
        job.needsWaveform = false
        return false
      }
    }

    const listRoot = await findSongListRoot(path.dirname(filePath))
    if (listRoot) {
      const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
      if (cached && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1) {
        const cachedKey = (cached.info as any)?.key
        const cachedBpm = (cached.info as any)?.bpm
        const hasKey = isValidKeyText(cachedKey)
        const hasBpm = isValidBpm(cachedBpm)
        if (hasKey || hasBpm) {
          this.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: hasKey ? cachedKey : undefined,
            bpm: hasBpm ? cachedBpm : undefined,
            hasWaveform: done?.hasWaveform
          })
        }
        if (needsKey && hasKey) {
          needsKey = false
        }
        if (needsBpm && hasBpm) {
          needsBpm = false
        }
        const hasWaveform = await LibraryCacheDb.hasWaveformCacheEntry(listRoot, filePath, stat)
        if (hasWaveform) {
          const existingDone = this.doneByPath.get(job.normalizedPath)
          this.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: existingDone?.keyText,
            bpm: existingDone?.bpm,
            hasWaveform: true
          })
          needsWaveform = false
        }
        if (!needsKey && !needsBpm && !needsWaveform) {
          job.needsKey = false
          job.needsBpm = false
          job.needsWaveform = false
          return false
        }
      }
    } else {
      needsWaveform = false
    }

    job.needsKey = needsKey
    job.needsBpm = needsBpm
    job.needsWaveform = needsWaveform
    return true
  }

  private async handleMissingFile(filePath: string) {
    try {
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
      }
    } catch {}
  }

  private hasForegroundWork(): boolean {
    if (
      this.pendingHigh.length > 0 ||
      this.pendingMedium.length > 0 ||
      this.pendingLow.length > 0
    ) {
      return true
    }
    for (const job of this.inFlight.values()) {
      if (job.source === 'foreground') return true
    }
    return false
  }

  private isIdle(): boolean {
    return (
      this.inFlight.size === 0 &&
      this.pendingHigh.length === 0 &&
      this.pendingMedium.length === 0 &&
      this.pendingLow.length === 0 &&
      this.pendingBackground.length === 0
    )
  }

  private getAudioExtensions(): Set<string> {
    const result = new Set<string>()
    const raw = store.settingConfig?.audioExt
    if (!Array.isArray(raw)) return result
    for (const item of raw) {
      if (!item) continue
      let ext = String(item).trim().toLowerCase()
      if (!ext) continue
      if (!ext.startsWith('.')) ext = `.${ext}`
      result.add(ext)
    }
    return result
  }

  private resolveSongListRoots(): string[] {
    const rootDir = store.databaseDir
    if (!rootDir) return []
    const rows = loadLibraryNodes(rootDir) || []
    const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
    if (!root) return []
    const childrenMap = new Map<string, LibraryNodeRow[]>()
    for (const row of rows) {
      if (!row.parentUuid) continue
      const list = childrenMap.get(row.parentUuid)
      if (list) {
        list.push(row)
      } else {
        childrenMap.set(row.parentUuid, [row])
      }
    }
    const pathByUuid = new Map<string, string>()
    pathByUuid.set(root.uuid, root.dirName)
    const queue: LibraryNodeRow[] = [root]
    for (let i = 0; i < queue.length; i += 1) {
      const parent = queue[i]
      const parentPath = pathByUuid.get(parent.uuid)
      if (!parentPath) continue
      const children = childrenMap.get(parent.uuid) || []
      for (const child of children) {
        const childPath = path.join(parentPath, child.dirName)
        if (!pathByUuid.has(child.uuid)) {
          pathByUuid.set(child.uuid, childPath)
          queue.push(child)
        }
      }
    }
    const roots: string[] = []
    for (const row of rows) {
      if (row.nodeType !== 'songList') continue
      const rel = pathByUuid.get(row.uuid)
      if (!rel) continue
      roots.push(path.join(rootDir, rel))
    }
    return roots
  }

  private refreshBackgroundRoots(): string[] {
    const now = Date.now()
    const shouldRefresh =
      now - this.backgroundRootsLastRefresh >= BACKGROUND_FS_REFRESH_MS ||
      this.backgroundRoots.length === 0
    if (!shouldRefresh) return this.backgroundRoots
    const nextRoots = this.resolveSongListRoots()
    const signature = nextRoots.join('|')
    if (signature !== this.backgroundRootsSignature) {
      this.backgroundDirQueue = []
      this.backgroundRootIndex = 0
      this.backgroundRootsSignature = signature
    }
    this.backgroundRoots = nextRoots
    this.backgroundRootsLastRefresh = now
    return this.backgroundRoots
  }

  private clearBackgroundTimer() {
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer)
      this.backgroundTimer = null
    }
  }

  private scheduleBackgroundScan() {
    if (this.backgroundTimer) return
    if (!this.isIdle()) return
    const now = Date.now()
    const idleDelay = Math.max(BACKGROUND_IDLE_DELAY_MS - (now - this.lastForegroundAt), 0)
    const cooldownDelay = Math.max(
      BACKGROUND_SCAN_COOLDOWN_MS - (now - this.backgroundLastScanAt),
      0
    )
    const delay = Math.max(idleDelay, cooldownDelay)
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null
      void this.runBackgroundScan()
    }, delay)
  }

  private async runBackgroundScan() {
    if (this.backgroundScanInProgress) return
    if (!this.isIdle()) return
    const now = Date.now()
    if (now - this.lastForegroundAt < BACKGROUND_IDLE_DELAY_MS) {
      this.scheduleBackgroundScan()
      return
    }
    if (now - this.backgroundLastScanAt < BACKGROUND_SCAN_COOLDOWN_MS) {
      this.scheduleBackgroundScan()
      return
    }
    this.backgroundScanInProgress = true
    this.backgroundLastScanAt = now
    try {
      const candidates = await this.collectBackgroundCandidates(BACKGROUND_BATCH_SIZE)
      if (candidates.length > 0) {
        this.enqueueList(candidates, 'background', { source: 'background' })
      } else {
        await this.cleanupMissingCacheEntries(BACKGROUND_CLEAN_BATCH_SIZE)
      }
    } finally {
      this.backgroundScanInProgress = false
      if (this.isIdle()) {
        this.scheduleBackgroundScan()
      }
    }
  }

  private async collectBackgroundCandidates(limit: number): Promise<string[]> {
    const fromCache = await this.collectBackgroundCacheCandidates(limit)
    if (fromCache.length > 0) return fromCache
    return await this.collectBackgroundFsCandidates(limit)
  }

  private async collectBackgroundCacheCandidates(limit: number): Promise<string[]> {
    const results: string[] = []
    if (limit <= 0) return results
    const db = getLibraryDb()
    if (!db) return results
    let rows: Array<{
      rowId: number
      list_root: string
      file_path: string
      info_json: string
      size: number
      mtime_ms: number
    }> = []
    try {
      const stmt = db.prepare(
        'SELECT rowid as rowId, list_root, file_path, info_json, size, mtime_ms FROM song_cache WHERE rowid > ? ORDER BY rowid LIMIT ?'
      )
      rows = stmt.all(this.backgroundCursor, BACKGROUND_SCAN_ROW_LIMIT)
    } catch {
      return results
    }
    if (!rows || rows.length === 0) {
      if (this.backgroundCursor !== 0) {
        this.backgroundCursor = 0
      }
      return results
    }
    let processedAll = true
    let lastRowId = this.backgroundCursor
    for (const row of rows) {
      const rowId = Number(row?.rowId)
      if (!Number.isFinite(rowId)) continue
      lastRowId = rowId
      const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
      if (!filePath) continue
      let info: { key?: unknown; bpm?: unknown } | null = null
      try {
        info = JSON.parse(String(row?.info_json || '{}')) as { key?: unknown; bpm?: unknown }
      } catch {
        info = null
      }
      const hasKey = isValidKeyText(info?.key)
      const hasBpm = isValidBpm(info?.bpm)
      const listRoot = typeof row?.list_root === 'string' ? row.list_root.trim() : ''
      const size = Number(row?.size)
      const mtimeMs = Number(row?.mtime_ms)
      let hasWaveform = false
      if (listRoot && Number.isFinite(size) && Number.isFinite(mtimeMs)) {
        hasWaveform = await LibraryCacheDb.hasWaveformCacheEntryByMeta(
          listRoot,
          filePath,
          size,
          mtimeMs
        )
      }
      if (!hasKey || !hasBpm || !hasWaveform) {
        results.push(filePath)
        if (results.length >= limit) {
          processedAll = false
          break
        }
      }
    }
    this.backgroundCursor = lastRowId
    if (processedAll && rows.length < BACKGROUND_SCAN_ROW_LIMIT) {
      this.backgroundCursor = 0
    }
    return results
  }

  private async collectBackgroundFsCandidates(limit: number): Promise<string[]> {
    const results: string[] = []
    if (limit <= 0) return results
    if (!store.databaseDir) return results
    if (this.hasForegroundWork()) return results
    const roots = this.refreshBackgroundRoots()
    if (roots.length === 0) return results
    const audioExts = this.getAudioExtensions()
    if (audioExts.size === 0) return results

    let dirsProcessed = 0
    while (results.length < limit && dirsProcessed < BACKGROUND_FS_DIR_LIMIT) {
      if (this.hasForegroundWork()) break
      if (this.backgroundDirQueue.length === 0) {
        const nextRoot = roots[this.backgroundRootIndex % roots.length]
        this.backgroundRootIndex = (this.backgroundRootIndex + 1) % roots.length
        if (!nextRoot) break
        this.backgroundDirQueue.push({ dir: nextRoot, listRoot: nextRoot })
      }
      const current = this.backgroundDirQueue.shift()
      if (!current) break
      dirsProcessed += 1
      let dirHandle: DirHandle
      try {
        dirHandle = await fs.opendir(current.dir)
      } catch {
        continue
      }
      let entryCount = 0
      try {
        for await (const entry of dirHandle) {
          if (entryCount >= BACKGROUND_FS_ENTRY_LIMIT) break
          if (this.hasForegroundWork()) break
          entryCount += 1
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === '.frkb_covers') continue
            const childDir = path.join(current.dir, entry.name)
            this.backgroundDirQueue.push({ dir: childDir, listRoot: current.listRoot })
            continue
          }
          if (!entry.isFile()) continue
          const ext = path.extname(entry.name).toLowerCase()
          if (!audioExts.has(ext)) continue
          const filePath = path.join(current.dir, entry.name)
          const normalizedPath = normalizePath(filePath)
          if (this.pendingByPath.has(normalizedPath) || this.activeByPath.has(normalizedPath)) {
            continue
          }
          const done = this.doneByPath.get(normalizedPath)
          if (done && isValidKeyText(done.keyText) && isValidBpm(done.bpm)) {
            continue
          }
          const cached = await LibraryCacheDb.loadSongCacheEntry(current.listRoot, filePath)
          if (cached === undefined) continue
          const cachedKey = cached?.info ? (cached.info as any).key : undefined
          const cachedBpm = cached?.info ? (cached.info as any).bpm : undefined
          const hasKey = isValidKeyText(cachedKey)
          const hasBpm = isValidBpm(cachedBpm)
          let hasWaveform = false
          if (cached && Number.isFinite(cached.size) && Number.isFinite(cached.mtimeMs)) {
            hasWaveform = await LibraryCacheDb.hasWaveformCacheEntryByMeta(
              current.listRoot,
              filePath,
              cached.size,
              cached.mtimeMs
            )
          }
          if (!cached || !hasKey || !hasBpm || !hasWaveform) {
            results.push(filePath)
            if (results.length >= limit) break
          }
        }
      } finally {
        try {
          await dirHandle.close()
        } catch {}
      }
    }
    return results
  }

  private async cleanupMissingCacheEntries(limit: number): Promise<number> {
    if (limit <= 0) return 0
    if (this.hasForegroundWork()) return 0
    const db = getLibraryDb()
    if (!db) return 0
    let rows: Array<{ rowId: number; list_root: string; file_path: string }> = []
    try {
      const stmt = db.prepare(
        'SELECT rowid as rowId, list_root, file_path FROM song_cache WHERE rowid > ? ORDER BY rowid LIMIT ?'
      )
      rows = stmt.all(this.backgroundCleanCursor, BACKGROUND_CLEAN_ROW_LIMIT)
    } catch {
      return 0
    }
    if (!rows || rows.length === 0) {
      if (this.backgroundCleanCursor !== 0) {
        this.backgroundCleanCursor = 0
      }
      return 0
    }
    let removed = 0
    let lastRowId = this.backgroundCleanCursor
    const listRootExistsCache = new Map<string, boolean>()
    for (const row of rows) {
      if (this.hasForegroundWork()) break
      const rowId = Number(row?.rowId)
      if (!Number.isFinite(rowId)) continue
      lastRowId = rowId
      const listRoot = typeof row?.list_root === 'string' ? row.list_root.trim() : ''
      const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
      if (!listRoot || !filePath) continue
      let listRootExists = listRootExistsCache.get(listRoot)
      if (listRootExists === undefined) {
        try {
          const st = await fs.stat(listRoot)
          listRootExists = st.isDirectory()
        } catch {
          listRootExists = false
        }
        listRootExistsCache.set(listRoot, listRootExists)
      }
      if (!listRootExists) continue
      let fileExists = false
      try {
        const st = await fs.stat(filePath)
        fileExists = st.isFile()
      } catch {
        fileExists = false
      }
      if (fileExists) continue
      await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
      await this.removeCoverCacheForMissingTrack(listRoot, filePath)
      this.doneByPath.delete(normalizePath(filePath))
      removed += 1
      if (removed >= limit) break
    }
    this.backgroundCleanCursor = lastRowId
    if (rows.length < BACKGROUND_CLEAN_ROW_LIMIT) {
      this.backgroundCleanCursor = 0
    }
    if (removed > 0) {
      log.info('[key-analysis] cleanup', { removed })
    }
    return removed
  }

  private async removeCoverCacheForMissingTrack(listRoot: string, filePath: string) {
    try {
      const removed = await LibraryCacheDb.removeCoverIndexEntry(listRoot, filePath)
      if (removed === undefined || !removed) return
      const remaining = await LibraryCacheDb.countCoverIndexByHash(listRoot, removed.hash)
      if (remaining !== 0) return
      const coverPath = path.join(
        listRoot,
        '.frkb_covers',
        `${removed.hash}${removed.ext || '.jpg'}`
      )
      try {
        await fs.rm(coverPath, { force: true })
      } catch {}
    } catch {}
  }

  private maybePreemptBackground() {
    if (this.idle.length > 0) return
    for (const [worker, jobId] of this.busy.entries()) {
      const job = this.inFlight.get(jobId)
      if (job && job.source === 'background') {
        this.preemptedJobIds.add(jobId)
        void worker.terminate().catch(() => {})
        return
      }
    }
  }

  private countBackgroundInFlight(): number {
    let count = 0
    for (const job of this.inFlight.values()) {
      if (job.source === 'background') count += 1
    }
    return count
  }

  private drain() {
    while (this.idle.length > 0) {
      const hasForegroundPending =
        this.pendingHigh.length > 0 || this.pendingMedium.length > 0 || this.pendingLow.length > 0
      if (!hasForegroundPending && this.pendingBackground.length > 0) {
        if (this.countBackgroundInFlight() >= BACKGROUND_MAX_INFLIGHT) break
      }
      const job = this.popNextJob()
      if (!job) break
      const worker = this.idle.shift()
      if (!worker) break
      this.busy.set(worker, job.jobId)
      this.inFlight.set(job.jobId, job)
      this.activeByPath.set(job.normalizedPath, job)

      void (async () => {
        const ready = await this.prepareJob(job)
        if (!ready) {
          this.inFlight.delete(job.jobId)
          this.busy.delete(worker)
          this.activeByPath.delete(job.normalizedPath)
          this.idle.push(worker)
          this.drain()
          return
        }
        log.info('[key-analysis] start', {
          filePath: job.filePath,
          priority: job.priority,
          source: job.source,
          fastAnalysis: job.fastAnalysis
        })
        worker.postMessage({
          jobId: job.jobId,
          filePath: job.filePath,
          fastAnalysis: job.fastAnalysis,
          needsKey: job.needsKey,
          needsBpm: job.needsBpm,
          needsWaveform: job.needsWaveform
        })
      })()
    }
    if (this.isIdle()) {
      this.scheduleBackgroundScan()
    }
  }

  invalidateDoneByPath(filePaths: string[]) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      if (!filePath) continue
      this.doneByPath.delete(normalizePath(filePath))
    }
  }
}

const workerCount = Math.max(1, Math.min(2, os.cpus().length))
export const keyAnalysisEvents = new EventEmitter()
let queue: KeyAnalysisQueue | null = null

const getQueue = () => {
  if (!queue) {
    queue = new KeyAnalysisQueue(workerCount, keyAnalysisEvents)
  }
  return queue
}

export function enqueueKeyAnalysis(filePath: string, priority: KeyAnalysisPriority = 'low') {
  getQueue().enqueue(filePath, priority)
}

export function enqueueKeyAnalysisList(filePaths: string[], priority: KeyAnalysisPriority = 'low') {
  getQueue().enqueueList(filePaths, priority)
}

export function enqueueKeyAnalysisImmediate(filePath: string) {
  getQueue().enqueue(filePath, 'high', { urgent: true })
}

export function startKeyAnalysisBackground() {
  getQueue().startBackgroundSweep()
}

export function invalidateKeyAnalysisCache(filePaths: string[] | string) {
  if (!queue) return
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  queue.invalidateDoneByPath(list)
}
