import fs from 'node:fs/promises'
import path from 'node:path'
import type { MixxxWaveformData } from '../../waveformCache'

export type KeyAnalysisPriority = 'high' | 'medium' | 'low' | 'background'
export type KeyAnalysisSource = 'foreground' | 'background'

export type KeyAnalysisJob = {
  jobId: number
  filePath: string
  normalizedPath: string
  priority: KeyAnalysisPriority
  fastAnalysis: boolean
  source: KeyAnalysisSource
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  startTime?: number
}

export type KeyAnalysisResult = {
  filePath: string
  keyText: string
}

export type BpmAnalysisResult = {
  filePath: string
  bpm: number
  firstBeatMs?: number
}

export type DoneEntry = {
  size: number
  mtimeMs: number
  keyText?: string
  bpm?: number
  hasWaveform?: boolean
}

export type WorkerPayload = {
  jobId: number
  filePath: string
  result?: {
    keyText?: string
    keyError?: string
    bpm?: number
    firstBeatMs?: number
    bpmError?: string
    mixxxWaveformData?: MixxxWaveformData | null
  }
  error?: string
}

export type KeyAnalysisBackgroundStatus = {
  active: boolean
  pending: number
  inFlight: number
  processing: number
  scanInProgress: boolean
  enabled: boolean
}

export type BackgroundDirItem = {
  dir: string
  listRoot: string
}

export type DirHandle = Awaited<ReturnType<typeof fs.opendir>>

export const normalizePath = (value: string): string => {
  let normalized = path.normalize(value || '')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

export const isValidKeyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

export const isValidBpm = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

export const BACKGROUND_IDLE_DELAY_MS = 3000
export const BACKGROUND_SCAN_COOLDOWN_MS = 5000
export const BACKGROUND_SCAN_ROW_LIMIT = 200
export const BACKGROUND_BATCH_SIZE = 1
export const BACKGROUND_MAX_INFLIGHT = 1
export const BACKGROUND_FS_REFRESH_MS = 60000
export const BACKGROUND_FS_DIR_LIMIT = 3
export const BACKGROUND_FS_ENTRY_LIMIT = 200
export const BACKGROUND_CLEAN_ROW_LIMIT = 200
export const BACKGROUND_CLEAN_BATCH_SIZE = 20
export const BACKGROUND_LIBRARY_TREE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
export const BACKGROUND_COVER_CLEANUP_INTERVAL_MS = 10 * 60 * 1000
export const BACKGROUND_COVER_CLEANUP_BATCH_SIZE = 3
