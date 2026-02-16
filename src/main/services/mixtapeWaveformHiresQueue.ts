import fs from 'node:fs/promises'
import path from 'node:path'
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import { requestMixtapeWaveform } from './mixtapeWaveformQueue'
import mixtapeWindow from '../window/mixtapeWindow'
import type { MixxxWaveformData } from '../waveformCache'

const MIXTAPE_HIRES_TARGET_RATE = 4000
const MAX_CONCURRENT = 1
const BACKGROUND_SCAN_INTERVAL_MS = 120_000
const BACKGROUND_INITIAL_DELAY_MS = 45_000
const BACKGROUND_SCAN_MAX_ITEMS = 24

type QueueTask = {
  filePath: string
  listRoot?: string
  targetRate: number
}

type EnsureHiresResult = {
  data: MixxxWaveformData | null
  source: 'cache' | 'computed' | 'computed-no-root' | 'missing-file' | 'error'
}

const queue: QueueTask[] = []
const pendingKeys = new Set<string>()
const inflightKeys = new Set<string>()
let activeCount = 0
let backgroundEnabled = false
let backgroundTimer: ReturnType<typeof setTimeout> | null = null

const normalizeTargetRate = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return MIXTAPE_HIRES_TARGET_RATE
  return Math.max(1, Math.round(parsed))
}

const toTaskKey = (filePath: string, targetRate: number) =>
  `${String(filePath || '')
    .trim()
    .toLowerCase()}|${targetRate}`

const notifyWaveformUpdated = (filePath: string) => {
  try {
    mixtapeWindow.broadcast?.('mixtape-waveform-updated', { filePath })
  } catch {}
}

export async function ensureMixtapeWaveformHires(
  filePath: string,
  options: { listRoot?: string; targetRate?: number } = {}
): Promise<EnsureHiresResult> {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) return { data: null, source: 'error' }
  const targetRate = normalizeTargetRate(options.targetRate)
  const providedRoot = typeof options.listRoot === 'string' ? options.listRoot.trim() : ''

  try {
    const stat = await fs.stat(normalized).catch(() => null)
    if (!stat) {
      if (providedRoot) {
        await LibraryCacheDb.removeMixtapeWaveformHiresCacheEntry(
          providedRoot,
          normalized,
          targetRate
        )
      }
      return { data: null, source: 'missing-file' }
    }
    const resolvedRoot = providedRoot || (await findSongListRoot(path.dirname(normalized))) || ''
    if (resolvedRoot) {
      const cached = await LibraryCacheDb.loadMixtapeWaveformHiresCacheData(
        resolvedRoot,
        normalized,
        targetRate,
        { size: stat.size, mtimeMs: stat.mtimeMs }
      )
      if (cached) {
        return { data: cached, source: 'cache' }
      }
    }

    const computed = await requestMixtapeWaveform(normalized, targetRate, {
      traceLabel: 'mixtape-waveform-hires'
    })
    if (!computed) return { data: null, source: resolvedRoot ? 'error' : 'computed-no-root' }
    if (resolvedRoot) {
      await LibraryCacheDb.upsertMixtapeWaveformHiresCacheEntry(
        resolvedRoot,
        normalized,
        targetRate,
        { size: stat.size, mtimeMs: stat.mtimeMs },
        computed
      )
      notifyWaveformUpdated(normalized)
      return { data: computed, source: 'computed' }
    }
    return { data: computed, source: 'computed-no-root' }
  } catch (error) {
    log.error('[mixtape] ensure hires waveform failed', {
      filePath: normalized,
      targetRate,
      error
    })
    return { data: null, source: 'error' }
  }
}

const processTask = async (task: QueueTask) => {
  const { filePath, listRoot, targetRate } = task
  const key = toTaskKey(filePath, targetRate)
  if (inflightKeys.has(key)) return
  inflightKeys.add(key)
  try {
    await ensureMixtapeWaveformHires(filePath, { listRoot, targetRate })
  } finally {
    inflightKeys.delete(key)
    pendingKeys.delete(key)
  }
}

const drainQueue = () => {
  if (activeCount >= MAX_CONCURRENT) return
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift()
    if (!task) break
    activeCount += 1
    void processTask(task)
      .catch(() => {})
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1)
        drainQueue()
      })
  }
}

export function queueMixtapeWaveformHires(
  filePaths: string[],
  listRoot?: string,
  targetRate?: number
): void {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  const rate = normalizeTargetRate(targetRate)
  const resolvedRoot = typeof listRoot === 'string' ? listRoot.trim() : ''
  for (const raw of filePaths) {
    const filePath = typeof raw === 'string' ? raw.trim() : ''
    if (!filePath) continue
    const key = toTaskKey(filePath, rate)
    if (pendingKeys.has(key) || inflightKeys.has(key)) continue
    pendingKeys.add(key)
    queue.push({
      filePath,
      listRoot: resolvedRoot || undefined,
      targetRate: rate
    })
  }
  drainQueue()
}

async function runBackgroundScan(targetRate: number): Promise<void> {
  if (!backgroundEnabled) return
  const db = getLibraryDb()
  if (!db) return
  try {
    const rows = db.prepare('SELECT DISTINCT file_path FROM mixtape_items').all() as Array<{
      file_path: string
    }>
    if (!rows || rows.length === 0) return

    const pending: string[] = []
    for (const row of rows) {
      const filePath = row?.file_path ? String(row.file_path).trim() : ''
      if (!filePath) continue
      const stat = await fs.stat(filePath).catch(() => null)
      if (!stat) continue
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (!listRoot) continue
      const cached = await LibraryCacheDb.loadMixtapeWaveformHiresCacheData(
        listRoot,
        filePath,
        targetRate,
        { size: stat.size, mtimeMs: stat.mtimeMs }
      )
      if (cached) continue
      pending.push(filePath)
      if (pending.length >= BACKGROUND_SCAN_MAX_ITEMS) break
    }
    if (pending.length > 0) {
      queueMixtapeWaveformHires(pending, undefined, targetRate)
    }
  } catch (error) {
    log.error('[mixtape][hires] background scan failed', error)
  }
}

const scheduleNextBackgroundScan = (targetRate: number) => {
  if (!backgroundEnabled || backgroundTimer) return
  backgroundTimer = setTimeout(() => {
    backgroundTimer = null
    void runBackgroundScan(targetRate).finally(() => {
      scheduleNextBackgroundScan(targetRate)
    })
  }, BACKGROUND_SCAN_INTERVAL_MS)
}

export function startMixtapeWaveformHiresBackground(targetRate?: number): void {
  if (backgroundEnabled) return
  backgroundEnabled = true
  const rate = normalizeTargetRate(targetRate)
  setTimeout(() => {
    if (!backgroundEnabled) return
    void runBackgroundScan(rate).finally(() => {
      scheduleNextBackgroundScan(rate)
    })
  }, BACKGROUND_INITIAL_DELAY_MS)
}

export function stopMixtapeWaveformHiresBackground(): void {
  backgroundEnabled = false
  if (backgroundTimer) {
    clearTimeout(backgroundTimer)
    backgroundTimer = null
  }
}
