import path from 'node:path'
import type { IPioneerPlaylistTrack, ISongHotCue, ISongMemoryCue } from '../../../types/globals'
import { log } from '../../log'
import { readPioneerCuesInWorker } from './workerPool'

type RustPioneerHotCueRecord = {
  slot?: number
  label?: string
  timeSec?: number
  isLoop?: boolean
  loopTimeSec?: number | null
  comment?: string | null
  colorIndex?: number | null
  colorName?: string | null
  colorHex?: string | null
  source?: string | null
}

type RustPioneerMemoryCueRecord = {
  timeSec?: number
  isLoop?: boolean
  loopTimeSec?: number | null
  order?: number
  comment?: string | null
  colorIndex?: number | null
  colorName?: string | null
  colorHex?: string | null
  source?: string | null
}

type RustPioneerCueDump = {
  analyzeFilePath?: string
  cueFilePath?: string
  hotCues?: RustPioneerHotCueRecord[]
  memoryCues?: RustPioneerMemoryCueRecord[]
  error?: string
}

type WorkerCueProgressItem = {
  analyzeFilePath?: string
  dump?: RustPioneerCueDump | null
}

type PioneerTrackCueData = {
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
}

const normalizeText = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}

const normalizeNonNegativeNumber = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
}

const normalizeOptionalInteger = (value: unknown) => {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

const normalizeAbsolutePathKey = (value: string) => {
  const normalized = path.resolve(String(value || '').trim())
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const isTrueAbsolutePath = (value: string) => {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (process.platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(normalized) || /^\\\\[^\\]/.test(normalized)
  }
  return normalized.startsWith('/')
}

const resolveAbsoluteAnalyzePath = (rootPath: string, analyzePath: string) => {
  const normalizedAnalyzePath = String(analyzePath || '').trim()
  if (!normalizedAnalyzePath) return ''
  if (isTrueAbsolutePath(normalizedAnalyzePath)) {
    return path.normalize(normalizedAnalyzePath)
  }
  const sanitized = normalizedAnalyzePath.replace(/^[/\\]+/, '')
  return path.join(String(rootPath || '').trim(), sanitized)
}

const normalizeHotCueRecord = (record: RustPioneerHotCueRecord): ISongHotCue | null => {
  const slot = normalizeOptionalInteger(record?.slot)
  const sec = normalizeNonNegativeNumber(record?.timeSec)
  if (slot === undefined || sec === undefined) return null
  const loopEndSec = normalizeNonNegativeNumber(record?.loopTimeSec)
  return {
    slot,
    sec,
    label: normalizeText(record?.label),
    comment: normalizeText(record?.comment),
    colorIndex: normalizeOptionalInteger(record?.colorIndex),
    colorName: normalizeText(record?.colorName),
    color: normalizeText(record?.colorHex),
    isLoop: loopEndSec !== undefined && loopEndSec > sec ? Boolean(record?.isLoop) : false,
    loopEndSec: loopEndSec !== undefined && loopEndSec > sec ? loopEndSec : undefined,
    source: normalizeText(record?.source)
  }
}

const normalizeMemoryCueRecord = (record: RustPioneerMemoryCueRecord): ISongMemoryCue | null => {
  const sec = normalizeNonNegativeNumber(record?.timeSec)
  if (sec === undefined) return null
  const loopEndSec = normalizeNonNegativeNumber(record?.loopTimeSec)
  return {
    sec,
    order: normalizeOptionalInteger(record?.order),
    comment: normalizeText(record?.comment),
    colorIndex: normalizeOptionalInteger(record?.colorIndex),
    colorName: normalizeText(record?.colorName),
    color: normalizeText(record?.colorHex),
    isLoop: loopEndSec !== undefined && loopEndSec > sec ? Boolean(record?.isLoop) : false,
    loopEndSec: loopEndSec !== undefined && loopEndSec > sec ? loopEndSec : undefined,
    source: normalizeText(record?.source)
  }
}

const normalizeCueDump = (dump: RustPioneerCueDump | null | undefined): PioneerTrackCueData => {
  const hotCues = Array.isArray(dump?.hotCues)
    ? dump.hotCues
        .map((item) => normalizeHotCueRecord(item))
        .filter((item): item is ISongHotCue => Boolean(item))
    : []
  const memoryCues = Array.isArray(dump?.memoryCues)
    ? dump.memoryCues
        .map((item) => normalizeMemoryCueRecord(item))
        .filter((item): item is ISongMemoryCue => Boolean(item))
    : []
  return {
    hotCues: hotCues.length ? hotCues : undefined,
    memoryCues: memoryCues.length ? memoryCues : undefined
  }
}

export async function enrichPioneerTracksWithCueData(
  rootPath: string,
  tracks: IPioneerPlaylistTrack[]
): Promise<IPioneerPlaylistTrack[]> {
  if (!Array.isArray(tracks) || tracks.length === 0) return []

  const analyzePathByAbsolute = new Map<string, string>()
  const absoluteAnalyzePaths: string[] = []
  for (const track of tracks) {
    const analyzePath = String(track?.analyzePath || '').trim()
    if (!analyzePath) continue
    const absoluteAnalyzePath = resolveAbsoluteAnalyzePath(rootPath, analyzePath)
    if (!absoluteAnalyzePath) continue
    const absoluteKey = normalizeAbsolutePathKey(absoluteAnalyzePath)
    if (analyzePathByAbsolute.has(absoluteKey)) continue
    analyzePathByAbsolute.set(absoluteKey, analyzePath)
    absoluteAnalyzePaths.push(absoluteAnalyzePath)
  }

  if (!absoluteAnalyzePaths.length) {
    return tracks.map((track) => ({
      ...track
    }))
  }

  const cueDataByAnalyzePath = new Map<string, PioneerTrackCueData>()
  try {
    await readPioneerCuesInWorker<{ total?: number }>(absoluteAnalyzePaths, (progress) => {
      const item = progress as WorkerCueProgressItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      if (!absoluteAnalyzePath) return
      const analyzePath = analyzePathByAbsolute.get(normalizeAbsolutePathKey(absoluteAnalyzePath))
      if (!analyzePath) return
      cueDataByAnalyzePath.set(analyzePath, normalizeCueDump(item?.dump || null))
    })
  } catch (error) {
    log.error('[pioneer-device-library] read cue data failed', {
      rootPath,
      error
    })
    return tracks.map((track) => ({
      ...track
    }))
  }

  return tracks.map((track) => {
    const analyzePath = String(track?.analyzePath || '').trim()
    const cueData = analyzePath ? cueDataByAnalyzePath.get(analyzePath) : undefined
    if (!cueData?.hotCues && !cueData?.memoryCues) {
      return {
        ...track
      }
    }
    return {
      ...track,
      hotCues: cueData.hotCues,
      memoryCues: cueData.memoryCues
    }
  })
}
