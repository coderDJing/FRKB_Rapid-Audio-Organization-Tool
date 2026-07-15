import fs from 'node:fs/promises'
import path from 'node:path'
import { enqueueKeyAnalysisList } from '../keyAnalysisQueue'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { findSongListRoot } from '../cacheMaintenance'
import { ensurePioneerUsbIdentity } from './usbIdentity'
import { hasUsableSongEnergyAnalysis } from '../../../shared/songEnergy'
import {
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2
} from '../../../shared/songAnalysisCompleteness'
import type { ISongInfo } from '../../../types/globals'
import type { ExternalAnalysisSourceKind } from '../../libraryCacheDb'

const EXTERNAL_PLAYBACK_SOURCE_ID = 'local'

type PioneerPlaylistAnalysisTrack = {
  filePath?: unknown
}

type RekordboxExternalAnalysisSourceKind = Exclude<ExternalAnalysisSourceKind, 'external-playback'>

type PioneerPlaylistAnalysisPrepareResult = {
  sourceKind: ExternalAnalysisSourceKind | ''
  sourceId: string
  usbUuid: string
  usbIdPersisted: boolean
  requested: number
  registered: number
  completeFilePaths: string[]
  queuedFilePaths: string[]
  missingFilePaths: string[]
  staleFilePaths: string[]
}

const normalizeRelativePath = (rootPath: string, filePath: string) => {
  const root = String(rootPath || '').trim()
  const file = String(filePath || '').trim()
  if (!root || !file) return ''
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return ''
  return relative.replace(/\\/g, '/')
}

const normalizeAbsolutePathKey = (filePath: string) => {
  const resolved = path.resolve(String(filePath || '').trim()).replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const buildExternalAnalysisRelativePath = (
  sourceKind: ExternalAnalysisSourceKind,
  rootPath: string,
  filePath: string
) => {
  const relativePath = normalizeRelativePath(rootPath, filePath)
  if (sourceKind === 'rekordbox-usb') {
    return relativePath
  }
  return relativePath || `abs:${normalizeAbsolutePathKey(filePath)}`
}

const hasCompleteFrkbAnalysis = (info: Partial<ISongInfo> | null | undefined) => {
  if (!info) return false
  return (
    hasUsableKeyAnalysis(info) &&
    hasUsableSongEnergyAnalysis(info) &&
    resolveCanonicalSongBeatGridV2(info).kind !== 'missing'
  )
}

const buildAnalysisOnlyInfo = (filePath: string) => {
  const info = applyLiteDefaults(buildLiteSongInfo(filePath), filePath)
  info.analysisOnly = true
  return info
}

const resolveAnalysisSource = async (params: {
  sourceKind: ExternalAnalysisSourceKind
  sourceId?: string
  rootPath: string
}) => {
  const rootPath = String(params?.rootPath || '').trim()
  if (params.sourceKind === 'rekordbox-usb') {
    const identity = await ensurePioneerUsbIdentity(rootPath)
    return {
      sourceKind: params.sourceKind,
      sourceId: identity.uuid,
      usbUuid: identity.uuid,
      usbIdPersisted: identity.persisted
    }
  }
  if (params.sourceKind === 'external-playback') {
    return {
      sourceKind: params.sourceKind,
      sourceId: String(params?.sourceId || '').trim() || EXTERNAL_PLAYBACK_SOURCE_ID,
      usbUuid: '',
      usbIdPersisted: false
    }
  }

  const sourceId =
    String(params?.sourceId || '').trim() ||
    (rootPath ? `rekordbox-desktop:${normalizeAbsolutePathKey(rootPath)}` : '')
  return {
    sourceKind: params.sourceKind,
    sourceId,
    usbUuid: '',
    usbIdPersisted: false
  }
}

async function prepareExternalSourcePlaylistAnalysis(params: {
  sourceKind: ExternalAnalysisSourceKind
  sourceId?: string
  rootPath: string
  tracks: PioneerPlaylistAnalysisTrack[]
}): Promise<PioneerPlaylistAnalysisPrepareResult> {
  const rootPath = String(params?.rootPath || '').trim()
  const tracks = Array.isArray(params?.tracks) ? params.tracks : []
  const source = await resolveAnalysisSource({
    sourceKind: params.sourceKind,
    sourceId: params.sourceId,
    rootPath
  })

  const result: PioneerPlaylistAnalysisPrepareResult = {
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    usbUuid: source.usbUuid,
    usbIdPersisted: source.usbIdPersisted,
    requested: tracks.length,
    registered: 0,
    completeFilePaths: [],
    queuedFilePaths: [],
    missingFilePaths: [],
    staleFilePaths: []
  }
  if ((source.sourceKind !== 'external-playback' && !rootPath) || !source.sourceId) return result

  await LibraryCacheDb.touchExternalAnalysisDevice(source.sourceKind, source.sourceId, rootPath)
  await LibraryCacheDb.pruneStaleExternalAnalysisDevices()
  if (tracks.length === 0) {
    await LibraryCacheDb.pruneStaleExternalAnalysisCacheEntries(source.sourceKind, source.sourceId)
    return result
  }

  const queued = new Set<string>()
  const complete = new Set<string>()
  for (const track of tracks) {
    const filePath = String(track?.filePath || '').trim()
    if (!filePath) continue
    if (source.sourceKind === 'external-playback') {
      const songListRoot = await findSongListRoot(path.dirname(filePath))
      if (songListRoot) continue
    }
    const relativePath = buildExternalAnalysisRelativePath(source.sourceKind, rootPath, filePath)
    if (!relativePath) continue
    const context = LibraryCacheDb.registerExternalAnalysisContext({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      rootPath,
      relativePath,
      filePath
    })
    if (!context) continue
    result.registered += 1

    let stat: { size: number; mtimeMs: number } | null = null
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      await LibraryCacheDb.removeExternalAnalysisCacheEntry(context)
      result.missingFilePaths.push(filePath)
      continue
    }

    const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, stat)
    if (cached === null) {
      result.staleFilePaths.push(filePath)
    }
    if (cached) {
      await LibraryCacheDb.touchExternalAnalysisCacheEntrySeen(context)
    }
    if (cached?.info && hasCompleteFrkbAnalysis(cached.info) && cached.hasWaveform) {
      complete.add(filePath)
      continue
    }

    if (!cached) {
      await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
        context,
        stat,
        buildAnalysisOnlyInfo(filePath)
      )
    }
    queued.add(filePath)
  }

  result.completeFilePaths = Array.from(complete)
  result.queuedFilePaths = Array.from(queued)
  await LibraryCacheDb.pruneStaleExternalAnalysisCacheEntries(source.sourceKind, source.sourceId)
  if (result.queuedFilePaths.length > 0) {
    enqueueKeyAnalysisList(result.queuedFilePaths, 'low', {
      source: 'foreground',
      preemptible: true,
      category: 'visible'
    })
  }
  return result
}

export async function prepareRekordboxExternalPlaylistAnalysis(params: {
  sourceKind: RekordboxExternalAnalysisSourceKind
  sourceId?: string
  rootPath: string
  tracks: PioneerPlaylistAnalysisTrack[]
}): Promise<PioneerPlaylistAnalysisPrepareResult> {
  return prepareExternalSourcePlaylistAnalysis(params)
}

export async function preparePioneerUsbPlaylistAnalysis(params: {
  rootPath: string
  tracks: PioneerPlaylistAnalysisTrack[]
}): Promise<PioneerPlaylistAnalysisPrepareResult> {
  return prepareRekordboxExternalPlaylistAnalysis({
    sourceKind: 'rekordbox-usb',
    rootPath: params.rootPath,
    tracks: params.tracks
  })
}

export async function prepareExternalPlaybackPlaylistAnalysis(params: {
  tracks: PioneerPlaylistAnalysisTrack[]
}): Promise<PioneerPlaylistAnalysisPrepareResult> {
  return prepareExternalSourcePlaylistAnalysis({
    sourceKind: 'external-playback',
    sourceId: EXTERNAL_PLAYBACK_SOURCE_ID,
    rootPath: '',
    tracks: params.tracks
  })
}
