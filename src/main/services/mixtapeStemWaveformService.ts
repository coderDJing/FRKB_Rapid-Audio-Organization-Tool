import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MixtapeStemMode } from '../mixtapeDb'
import { log } from '../log'
import type { MixxxWaveformData } from '../waveformCache'
import type { StemWaveformDataLite, StemWaveformStemId } from '../stemWaveformCache'
import * as LibraryCacheDb from '../libraryCacheDb'
import { requestMixtapeWaveform } from './mixtapeWaveformQueue'
import { findSongListRoot } from './cacheMaintenance'

const STEM_IDS_4: StemWaveformStemId[] = ['vocal', 'harmonic', 'bass', 'drums']
const DEFAULT_STEM_MODEL = 'htdemucs'
const DEFAULT_STEM_VERSION = 'unknown'
const DEFAULT_TARGET_RATE = 441

type StemWaveformPaths = {
  vocalPath?: string | null
  harmonicPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}

type StemWaveformEntry = {
  stemId: StemWaveformStemId
  filePath: string
  data: StemWaveformDataLite | null
}

type ResolvedStemItem = {
  stemId: StemWaveformStemId
  filePath: string
  stat: { size: number; mtimeMs: number }
}

export type MixtapeStemWaveformBundleResult = {
  sourceFilePath: string
  listRoot: string
  stemMode: MixtapeStemMode
  stemModel: string
  stemVersion: string
  targetRate: number
  stems: StemWaveformEntry[]
}

type EnsureMixtapeStemWaveformBundleParams = {
  listRoot?: string
  sourceFilePath: string
  stemMode: MixtapeStemMode
  stemModel?: string
  stemVersion?: string
  targetRate?: number
  stemPaths: StemWaveformPaths
}

const prewarmInflight = new Set<string>()

const normalizeText = (value: unknown, maxLen = 128): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizeStemMode = (_value: unknown): MixtapeStemMode => '4stems'

const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

const normalizeStemModel = (value: unknown): string =>
  normalizeText(value, 128) || DEFAULT_STEM_MODEL

const normalizeStemVersion = (value: unknown): string =>
  normalizeText(value, 128) || DEFAULT_STEM_VERSION

const normalizeTargetRate = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TARGET_RATE
  return Math.max(1, Math.round(parsed))
}

const normalizePathKey = (value: string): string => {
  if (!value) return ''
  return process.platform === 'win32' ? value.toLowerCase() : value
}

const toStemWaveformDataLite = (waveform: MixxxWaveformData): StemWaveformDataLite | null => {
  if (!waveform) return null
  const all = waveform.bands?.all
  if (!all) return null
  const frameCount = Math.min(
    all.left?.length || 0,
    all.right?.length || 0,
    all.peakLeft?.length || 0,
    all.peakRight?.length || 0
  )
  if (!frameCount) return null
  return {
    duration: Number(waveform.duration) || 0,
    sampleRate: Number(waveform.sampleRate) || 0,
    step: Number(waveform.step) || 0,
    all: {
      left: all.left.subarray(0, frameCount),
      right: all.right.subarray(0, frameCount),
      peakLeft: all.peakLeft.subarray(0, frameCount),
      peakRight: all.peakRight.subarray(0, frameCount)
    }
  }
}

const resolveRequiredStemIds = (_stemMode: MixtapeStemMode): StemWaveformStemId[] => STEM_IDS_4

const resolveStemPathById = (paths: StemWaveformPaths, stemId: StemWaveformStemId): string => {
  if (stemId === 'vocal') return normalizeFilePath(paths.vocalPath)
  if (stemId === 'harmonic') return normalizeFilePath(paths.harmonicPath)
  if (stemId === 'bass') return normalizeFilePath(paths.bassPath)
  return normalizeFilePath(paths.drumsPath)
}

const resolveListRootForSourceFile = async (
  listRoot: string,
  sourceFilePath: string
): Promise<string> => {
  const normalizedRoot = normalizeFilePath(listRoot)
  if (normalizedRoot) return normalizedRoot
  const sourcePath = normalizeFilePath(sourceFilePath)
  if (!sourcePath) return ''
  try {
    const detected = await findSongListRoot(path.dirname(sourcePath))
    return normalizeFilePath(detected)
  } catch {
    return ''
  }
}

const resolveStemItems = async (
  stemMode: MixtapeStemMode,
  stemPaths: StemWaveformPaths
): Promise<ResolvedStemItem[] | null> => {
  const requiredStemIds = resolveRequiredStemIds(stemMode)
  const resolved: ResolvedStemItem[] = []
  for (const stemId of requiredStemIds) {
    const filePath = resolveStemPathById(stemPaths, stemId)
    if (!filePath) return null
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat) return null
    resolved.push({
      stemId,
      filePath,
      stat: {
        size: stat.size,
        mtimeMs: stat.mtimeMs
      }
    })
  }
  return resolved
}

const buildSourceSignature = (
  stemMode: MixtapeStemMode,
  stemItems: ResolvedStemItem[],
  targetRate: number
): string => {
  const hash = crypto.createHash('sha1')
  hash.update(`mode:${stemMode}\nrate:${targetRate}\n`)
  for (const item of stemItems) {
    hash.update(
      `${item.stemId}|${normalizePathKey(item.filePath)}|${Math.max(0, item.stat.size)}|${Math.max(0, Math.floor(item.stat.mtimeMs))}\n`
    )
  }
  return hash.digest('hex')
}

const buildBundleStems = async (
  listRoot: string,
  targetRate: number,
  stemItems: ResolvedStemItem[]
): Promise<StemWaveformEntry[] | null> => {
  const stems: StemWaveformEntry[] = []
  for (const item of stemItems) {
    let data = await LibraryCacheDb.loadMixtapeWaveformCacheData(listRoot, item.filePath, item.stat)
    if (!data) {
      data = await requestMixtapeWaveform(item.filePath, targetRate, {
        traceLabel: 'mixtape-stem-waveform'
      })
      if (data) {
        await LibraryCacheDb.upsertMixtapeWaveformCacheEntry(
          listRoot,
          item.filePath,
          item.stat,
          data
        )
      }
    }
    if (!data) return null
    const lite = toStemWaveformDataLite(data)
    if (!lite) return null
    stems.push({
      stemId: item.stemId,
      filePath: item.filePath,
      data: lite
    })
  }
  return stems
}

const buildPrewarmKey = (params: EnsureMixtapeStemWaveformBundleParams): string => {
  const sourceFilePath = normalizePathKey(normalizeFilePath(params.sourceFilePath))
  const stemMode = normalizeStemMode(params.stemMode)
  const model = normalizeStemModel(params.stemModel)
  const stemVersion = normalizeStemVersion(params.stemVersion)
  const targetRate = normalizeTargetRate(params.targetRate)
  return `${sourceFilePath}::${stemMode}::${model}::${stemVersion}::${targetRate}`
}

export async function ensureMixtapeStemWaveformBundle(
  params: EnsureMixtapeStemWaveformBundleParams
): Promise<MixtapeStemWaveformBundleResult | null> {
  const sourceFilePath = normalizeFilePath(params?.sourceFilePath)
  if (!sourceFilePath) return null
  const stemMode = normalizeStemMode(params?.stemMode)
  const stemModel = normalizeStemModel(params?.stemModel)
  const stemVersion = normalizeStemVersion(params?.stemVersion)
  const targetRate = normalizeTargetRate(params?.targetRate)
  const listRoot = await resolveListRootForSourceFile(params?.listRoot || '', sourceFilePath)
  if (!listRoot) return null

  const stemItems = await resolveStemItems(stemMode, params?.stemPaths || {})
  if (!stemItems || !stemItems.length) return null
  const sourceSignature = buildSourceSignature(stemMode, stemItems, targetRate)
  if (!sourceSignature) return null

  const cached = await LibraryCacheDb.loadMixtapeStemWaveformCacheData({
    listRoot,
    filePath: sourceFilePath,
    stemMode,
    model: stemModel,
    stemVersion,
    targetRate,
    sourceSignature
  })
  if (cached) {
    const stems = stemItems.map((item) => ({
      stemId: item.stemId,
      filePath: item.filePath,
      data: cached.stems[item.stemId] || null
    }))
    if (stems.every((item) => item.data)) {
      return {
        sourceFilePath,
        listRoot,
        stemMode,
        stemModel,
        stemVersion,
        targetRate,
        stems
      }
    }
  }

  const stems = await buildBundleStems(listRoot, targetRate, stemItems)
  if (!stems) return null
  const stemMap = stems.reduce<Partial<Record<StemWaveformStemId, StemWaveformDataLite>>>(
    (acc, item) => {
      if (item.data) {
        acc[item.stemId] = item.data
      }
      return acc
    },
    {}
  )
  const stored = await LibraryCacheDb.upsertMixtapeStemWaveformCacheEntry(
    {
      listRoot,
      filePath: sourceFilePath,
      stemMode,
      model: stemModel,
      stemVersion,
      targetRate,
      sourceSignature
    },
    {
      stemMode,
      stems: stemMap
    }
  )
  if (!stored) {
    log.warn?.('[mixtape-stem-waveform] bundle cache store skipped', {
      sourceFilePath,
      stemMode,
      stemModel,
      stemVersion
    })
  }
  return {
    sourceFilePath,
    listRoot,
    stemMode,
    stemModel,
    stemVersion,
    targetRate,
    stems
  }
}

export function prewarmMixtapeStemWaveformBundle(
  params: EnsureMixtapeStemWaveformBundleParams
): void {
  const key = buildPrewarmKey(params)
  if (!key || prewarmInflight.has(key)) return
  prewarmInflight.add(key)
  void ensureMixtapeStemWaveformBundle(params)
    .catch((error) => {
      log.error('[mixtape-stem-waveform] prewarm failed', {
        sourceFilePath: normalizeFilePath(params?.sourceFilePath),
        stemMode: normalizeStemMode(params?.stemMode),
        error
      })
    })
    .finally(() => {
      prewarmInflight.delete(key)
    })
}
