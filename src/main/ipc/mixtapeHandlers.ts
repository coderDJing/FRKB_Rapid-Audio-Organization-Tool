import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'
import mixtapeWindow, {
  isMixtapeWindowOpenByPlaylistId,
  type MixtapeWindowPayload
} from '../window/mixtapeWindow'
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import {
  appendMixtapeItems,
  getMixtapeProjectMixMode,
  getMixtapeProjectStemConfig,
  listMixtapeItemsByItemIds,
  listMixtapeItemsByFilePath,
  listMixtapeFilePathsByItemIds,
  removeMixtapeItemsById,
  removeMixtapeItemsByFilePath,
  reorderMixtapeItems,
  upsertMixtapeProjectMixMode,
  upsertMixtapeProjectStemProfile,
  upsertMixtapeItemBpmByFilePath,
  upsertMixtapeItemGridByFilePath,
  upsertMixtapeItemGainEnvelopeById,
  upsertMixtapeItemMixEnvelopeById,
  upsertMixtapeItemVolumeMuteSegmentsById,
  upsertMixtapeItemStartSecById,
  type MixtapeMixMode,
  type MixtapeStemMode
} from '../mixtapeDb'
import { summarizeMixtapeStemStatusByPlaylist } from '../mixtapeStemDb'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { queueMixtapeRawWaveforms } from '../services/mixtapeRawWaveformQueue'
import { queueMixtapeWaveformHires } from '../services/mixtapeWaveformHiresQueue'
import { cleanupMixtapeWaveformCache } from '../services/mixtapeWaveformMaintenance'
import {
  enqueueMixtapeStemJobs,
  getMixtapeStemStatusSnapshot,
  retryMixtapeStemJobs
} from '../services/mixtapeStemQueue'
import {
  downloadPreferredStemRuntime,
  getPreferredStemRuntimeDownloadInfo,
  getStemRuntimeDownloadState
} from '../services/mixtapeStemRuntimeDownload'
import {
  analyzeMixtapeBpmBatchShared,
  reconcileMixtapeMissingFiles
} from './mixtapeHandlers.shared'
import {
  runMixtapeOutput,
  type MixtapeOutputInput,
  type MixtapeOutputProgressPayload
} from '../services/mixtapeOutput'

export function registerMixtapeHandlers() {
  const broadcastMixtapeItemsRemoved = (
    sender: Electron.WebContents | null,
    payload: {
      playlistId: string
      itemIds: string[]
      removedPaths: string[]
      removed: number
    }
  ) => {
    if (!payload.playlistId || payload.removed <= 0) return
    if (mainWindow.instance && mainWindow.instance.webContents !== sender) {
      mainWindow.instance.webContents.send('mixtape-items-removed', payload)
    }
    mixtapeWindow.broadcast?.('mixtape-items-removed', payload)
  }

  ipcMain.on('mixtape:open', (_e, payload: MixtapeWindowPayload) => {
    mixtapeWindow.open(payload || {})
  })

  ipcMain.handle('mixtape:is-window-open-by-playlist-id', (_e, playlistId?: string) => {
    return isMixtapeWindowOpenByPlaylistId(typeof playlistId === 'string' ? playlistId : '')
  })

  ipcMain.on('mixtapeWindow-open-dialog', (_e, key: string) => {
    if (!key) return
    try {
      mainWindow.instance?.webContents.send('openDialogFromTray', key)
    } catch {}
  })

  ipcMain.handle('mixtape:list', async (_e, payload: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    const { items, recovery } = await reconcileMixtapeMissingFiles(playlistId)
    const stemConfig = getMixtapeProjectStemConfig(playlistId)
    const stemSummary = summarizeMixtapeStemStatusByPlaylist(playlistId)
    return {
      items,
      recovery,
      mixMode: stemConfig.mixMode,
      stemProfile: stemConfig.stemProfile,
      stemSummary
    }
  })

  ipcMain.handle('mixtape:project:get-mix-mode', async (_e, payload?: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    return {
      mixMode: getMixtapeProjectMixMode(playlistId)
    }
  })

  ipcMain.handle(
    'mixtape:project:set-mix-mode',
    async (_e, payload?: { playlistId?: string; mixMode?: string }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const mixModeRaw = typeof payload?.mixMode === 'string' ? payload.mixMode : 'stem'
      return upsertMixtapeProjectMixMode(playlistId, mixModeRaw as MixtapeMixMode)
    }
  )

  ipcMain.handle(
    'mixtape:project:get-stem-profile',
    async (_e, payload?: { playlistId?: string }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const config = getMixtapeProjectStemConfig(playlistId)
      return {
        stemProfile: config.stemProfile
      }
    }
  )

  ipcMain.handle(
    'mixtape:project:set-stem-profile',
    async (
      _e,
      payload?: {
        playlistId?: string
        stemProfile?: string
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const current = getMixtapeProjectStemConfig(playlistId)
      return upsertMixtapeProjectStemProfile(
        playlistId,
        typeof payload?.stemProfile === 'string'
          ? (payload.stemProfile as any)
          : current.stemProfile
      )
    }
  )

  ipcMain.handle(
    'mixtape:stem:enqueue',
    async (
      _e,
      payload?: {
        playlistId?: string
        filePaths?: string[]
        stemMode?: string
        force?: boolean
        model?: string
        stemVersion?: string
        profile?: string
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const stemModeRaw =
        typeof payload?.stemMode === 'string' ? payload.stemMode : FIXED_MIXTAPE_STEM_MODE
      return enqueueMixtapeStemJobs({
        playlistId,
        filePaths,
        stemMode: stemModeRaw as MixtapeStemMode,
        force: !!payload?.force,
        model: typeof payload?.model === 'string' ? payload.model : undefined,
        stemVersion: typeof payload?.stemVersion === 'string' ? payload.stemVersion : undefined,
        profile: typeof payload?.profile === 'string' ? (payload.profile as any) : undefined
      })
    }
  )

  ipcMain.handle(
    'mixtape:stem:retry',
    async (
      _e,
      payload?: {
        playlistId?: string
        stemMode?: string
        itemIds?: string[]
        filePaths?: string[]
        model?: string
        stemVersion?: string
        profile?: string
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const stemModeRaw =
        typeof payload?.stemMode === 'string' ? payload.stemMode : FIXED_MIXTAPE_STEM_MODE
      return retryMixtapeStemJobs({
        playlistId,
        stemMode: stemModeRaw as MixtapeStemMode,
        itemIds: Array.isArray(payload?.itemIds) ? payload.itemIds : [],
        filePaths: Array.isArray(payload?.filePaths) ? payload.filePaths : [],
        model: typeof payload?.model === 'string' ? payload.model : undefined,
        stemVersion: typeof payload?.stemVersion === 'string' ? payload.stemVersion : undefined,
        profile: typeof payload?.profile === 'string' ? (payload.profile as any) : undefined
      })
    }
  )

  ipcMain.handle('mixtape:stem:get-status', async (_e, payload?: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    return getMixtapeStemStatusSnapshot(playlistId)
  })

  ipcMain.handle('mixtape:stem:runtime:get-status', async () => {
    return {
      preferred: await getPreferredStemRuntimeDownloadInfo(),
      state: getStemRuntimeDownloadState()
    }
  })

  ipcMain.handle('mixtape:stem:runtime:download-preferred', async () => {
    const started = await downloadPreferredStemRuntime()
    return {
      started,
      state: getStemRuntimeDownloadState()
    }
  })

  ipcMain.handle(
    'mixtape:append',
    async (
      _e,
      payload: {
        playlistId?: string
        items?: Array<{
          filePath: string
          originPlaylistUuid?: string | null
          originPathSnapshot?: string | null
          info?: Record<string, any> | null
          sourcePlaylistId?: string | null
          sourceItemId?: string | null
        }>
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const inputItems = Array.isArray(payload?.items) ? payload.items : []

      const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
      const normalizeInfo = (value: unknown): Record<string, any> | null => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        return value as Record<string, any>
      }
      const parseInfoJson = (value: unknown): Record<string, any> | null => {
        if (typeof value !== 'string' || !value.trim()) return null
        try {
          const parsed = JSON.parse(value)
          return normalizeInfo(parsed)
        } catch {
          return null
        }
      }
      const isLikelyAudioFilePath = (value: string) => {
        const normalized = normalizeText(value)
        if (!normalized) return false
        return path.isAbsolute(normalized)
      }
      const hasReadyStemPaths = (info: Record<string, any> | null): boolean => {
        if (!info) return false
        const vocal = normalizeText(info.stemVocalPath)
        const inst = normalizeText(info.stemInstPath)
        const drums = normalizeText(info.stemDrumsPath)
        if (!vocal || !inst || !drums) return false
        const bass = normalizeText(info.stemBassPath)
        return !!bass
      }
      const hasBpmReady = (info: Record<string, any> | null): boolean => {
        if (!info) return false
        const bpm = Number(info.bpm)
        return Number.isFinite(bpm) && bpm > 0
      }
      const ANALYSIS_COPY_FIELDS = [
        'bpm',
        'originalBpm',
        'firstBeatMs',
        'barBeatOffset',
        'key',
        'originalKey',
        'stemStatus',
        'stemReadyAt',
        'stemModel',
        'stemVersion',
        'stemVocalPath',
        'stemInstPath',
        'stemBassPath',
        'stemDrumsPath'
      ]
      const pickAnalysisInfo = (info: Record<string, any> | null): Record<string, any> | null => {
        if (!info) return null
        const picked: Record<string, any> = {}
        for (const key of ANALYSIS_COPY_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(info, key)) continue
          const value = info[key]
          if (value === undefined || value === null) continue
          if (typeof value === 'string' && !value.trim()) continue
          if (key === 'stemStatus' && value !== 'ready') continue
          picked[key] = value
        }
        return Object.keys(picked).length > 0 ? picked : null
      }
      const mergeInfoWithAnalysis = (
        baseInfo: Record<string, any> | null,
        analysisInfo: Record<string, any> | null
      ): Record<string, any> | null => {
        if (!baseInfo && !analysisInfo) return null
        if (!analysisInfo) return baseInfo
        if (!baseInfo) return { ...analysisInfo }
        const merged: Record<string, any> = { ...baseInfo }
        for (const key of ANALYSIS_COPY_FIELDS) {
          const nextValue = analysisInfo[key]
          if (nextValue === undefined || nextValue === null) continue
          if (
            merged[key] === undefined ||
            merged[key] === null ||
            (typeof merged[key] === 'string' && !String(merged[key]).trim())
          ) {
            merged[key] = nextValue
          }
        }
        return merged
      }

      const targetStemConfig = getMixtapeProjectStemConfig(playlistId)
      const targetPlaylistMixMode = targetStemConfig.mixMode
      const playlistMixModeById = new Map<string, string>([[playlistId, targetPlaylistMixMode]])
      const resolvePlaylistMixMode = (playlistUuid: string) => {
        const normalized = normalizeText(playlistUuid)
        if (!normalized) return ''
        const cached = playlistMixModeById.get(normalized)
        if (cached) return cached
        const config = getMixtapeProjectStemConfig(normalized)
        const mixMode = config.mixMode
        playlistMixModeById.set(normalized, mixMode)
        return mixMode
      }
      const sourceRefsByPlaylist = new Map<string, Set<string>>()
      for (const item of inputItems) {
        const sourcePlaylistId =
          normalizeText(item?.sourcePlaylistId) || normalizeText(item?.originPlaylistUuid)
        const sourceItemId = normalizeText(item?.sourceItemId)
        if (!sourcePlaylistId || !sourceItemId) continue
        if (!sourceRefsByPlaylist.has(sourcePlaylistId)) {
          sourceRefsByPlaylist.set(sourcePlaylistId, new Set<string>())
        }
        sourceRefsByPlaylist.get(sourcePlaylistId)?.add(sourceItemId)
      }

      const reusableInfoBySourceKey = new Map<string, Record<string, any>>()
      for (const [sourcePlaylistId, sourceItemIdSet] of sourceRefsByPlaylist.entries()) {
        if (resolvePlaylistMixMode(sourcePlaylistId) !== targetPlaylistMixMode) continue
        const sourceItemIds = Array.from(sourceItemIdSet)
        const sourceRows = listMixtapeItemsByItemIds(sourcePlaylistId, sourceItemIds)
        for (const row of sourceRows) {
          const sourceItemId = normalizeText(row?.id)
          const parsedInfo = parseInfoJson(row?.infoJson)
          if (!sourceItemId || !parsedInfo) continue
          reusableInfoBySourceKey.set(`${sourcePlaylistId}::${sourceItemId}`, parsedInfo)
        }
      }
      const reusableAnalysisByFilePath = new Map<string, Record<string, any>>()
      const uniqueInputFilePaths = Array.from(
        new Set(
          inputItems
            .map((item) => normalizeText(item?.filePath))
            .filter((filePath) => isLikelyAudioFilePath(filePath))
        )
      )
      for (const filePath of uniqueInputFilePaths) {
        const candidateRows = listMixtapeItemsByFilePath(filePath)
        let bestAnalysisInfo: Record<string, any> | null = null
        let bestScore = -1
        for (const row of candidateRows) {
          const candidatePlaylistId = normalizeText(row?.playlistUuid)
          if (!candidatePlaylistId) continue
          if (resolvePlaylistMixMode(candidatePlaylistId) !== targetPlaylistMixMode) continue
          const analysisInfo = pickAnalysisInfo(parseInfoJson(row?.infoJson))
          if (!analysisInfo) continue
          const score =
            (hasReadyStemPaths(analysisInfo) ? 10 : 0) + (hasBpmReady(analysisInfo) ? 1 : 0)
          if (score < bestScore) continue
          bestScore = score
          bestAnalysisInfo = analysisInfo
        }
        if (bestAnalysisInfo) {
          reusableAnalysisByFilePath.set(filePath, bestAnalysisInfo)
        }
      }

      const normalizedItems: Array<{
        filePath: string
        originPlaylistUuid?: string | null
        originPathSnapshot?: string | null
        info?: Record<string, any> | null
      }> = []
      const filePathSet = new Set<string>()
      const bpmAnalyzeFilePathSet = new Set<string>()
      const stemEnqueueFilePathSet = new Set<string>()
      let invalidPathCount = 0

      for (const item of inputItems) {
        const filePath = normalizeText(item?.filePath)
        if (!filePath) continue
        if (!isLikelyAudioFilePath(filePath)) {
          invalidPathCount += 1
          continue
        }
        const sourcePlaylistId =
          normalizeText(item?.sourcePlaylistId) || normalizeText(item?.originPlaylistUuid)
        const sourceItemId = normalizeText(item?.sourceItemId)
        const sourceInfo =
          sourcePlaylistId && sourceItemId
            ? reusableInfoBySourceKey.get(`${sourcePlaylistId}::${sourceItemId}`) || null
            : null
        const itemInfo = normalizeInfo(item?.info)
        const fallbackAnalysisInfo =
          sourceInfo || !reusableAnalysisByFilePath.has(filePath)
            ? null
            : reusableAnalysisByFilePath.get(filePath) || null
        const info = sourceInfo || mergeInfoWithAnalysis(itemInfo, fallbackAnalysisInfo)
        normalizedItems.push({
          filePath,
          originPlaylistUuid: item?.originPlaylistUuid || null,
          originPathSnapshot: item?.originPathSnapshot || null,
          info
        })
        filePathSet.add(filePath)
        if (!hasBpmReady(info)) {
          bpmAnalyzeFilePathSet.add(filePath)
        }
        if (!hasReadyStemPaths(info)) {
          stemEnqueueFilePathSet.add(filePath)
        }
      }
      if (invalidPathCount > 0) {
        log.warn('[mixtape] skip append items with invalid file path', {
          playlistId,
          invalidPathCount,
          inputCount: inputItems.length
        })
      }

      const result = appendMixtapeItems(playlistId, normalizedItems)
      const filePaths = Array.from(filePathSet)
      if (filePaths.length > 0) {
        queueMixtapeWaveforms(filePaths)
        queueMixtapeRawWaveforms(filePaths)
        queueMixtapeWaveformHires(filePaths)
        const stemEnqueueFilePaths = Array.from(stemEnqueueFilePathSet)
        if (stemEnqueueFilePaths.length > 0) {
          log.info('[mixtape-stem] enqueue after append request', {
            playlistId,
            fileCount: stemEnqueueFilePaths.length,
            mixMode: targetStemConfig.mixMode,
            stemMode: FIXED_MIXTAPE_STEM_MODE,
            appended: result?.inserted ?? 0
          })
          void enqueueMixtapeStemJobs({
            playlistId,
            filePaths: stemEnqueueFilePaths,
            stemMode: FIXED_MIXTAPE_STEM_MODE,
            profile: targetStemConfig.stemProfile
          }).catch((error) => {
            log.error('[mixtape-stem] enqueue after append failed', {
              playlistId,
              fileCount: stemEnqueueFilePaths.length,
              error
            })
          })
        } else {
          log.info('[mixtape-stem] skip enqueue after append: no pending stem paths', {
            playlistId,
            fileCount: stemEnqueueFilePaths.length
          })
        }
        const bpmAnalyzeFilePaths = Array.from(bpmAnalyzeFilePathSet)
        if (bpmAnalyzeFilePaths.length > 0) {
          // 预分�?BPM（后台，不阻塞返回）
          void analyzeMixtapeBpmBatchShared(bpmAnalyzeFilePaths)
            .then((bpmResult) => {
              if (bpmResult.results.length > 0) {
                upsertMixtapeItemBpmByFilePath(bpmResult.results)
                try {
                  mixtapeWindow.broadcast?.('mixtape-bpm-batch-ready', {
                    results: bpmResult.results
                  })
                } catch {}
              }
            })
            .catch(() => {})
        }
      }
      return result
    }
  )

  ipcMain.handle(
    'mixtape:remove',
    async (_e, payload: { playlistId?: string; filePaths?: string[]; itemIds?: string[] }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const itemIds = Array.isArray(payload?.itemIds) ? payload.itemIds : []
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      if (itemIds.length > 0) {
        const removedPaths = listMixtapeFilePathsByItemIds(playlistId, itemIds)
        const result = removeMixtapeItemsById(playlistId, itemIds)
        await cleanupMixtapeWaveformCache(removedPaths)
        broadcastMixtapeItemsRemoved(_e.sender, {
          playlistId,
          itemIds,
          removedPaths,
          removed: Number(result?.removed || 0)
        })
        return result
      }
      const result = removeMixtapeItemsByFilePath(playlistId, filePaths)
      await cleanupMixtapeWaveformCache(filePaths)
      broadcastMixtapeItemsRemoved(_e.sender, {
        playlistId,
        itemIds: [],
        removedPaths: filePaths,
        removed: Number(result?.removed || 0)
      })
      return result
    }
  )

  ipcMain.handle(
    'mixtape:reorder',
    async (_e, payload: { playlistId?: string; orderedIds?: string[] }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const orderedIds = Array.isArray(payload?.orderedIds) ? payload.orderedIds : []
      return reorderMixtapeItems(playlistId, orderedIds)
    }
  )

  ipcMain.handle('mixtape:analyze-bpm', async (_e, payload: { filePaths?: string[] }) => {
    const input = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    try {
      const result = await analyzeMixtapeBpmBatchShared(input)
      if (result.results.length > 0) {
        upsertMixtapeItemBpmByFilePath(result.results)
      }
      return result
    } catch (error) {
      log.error('[mixtape] BPM analyze invoke failed', {
        requested: input.length,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        results: [],
        unresolved: input,
        unresolvedDetails: input.map((filePath) => ({ filePath, reason: 'invoke failed' }))
      }
    }
  })

  ipcMain.handle('mixtape:output', async (event, payload?: MixtapeOutputInput) => {
    const sendProgress = (progress: MixtapeOutputProgressPayload) => {
      try {
        event.sender.send('mixtape-output:progress', progress)
      } catch {}
    }
    try {
      const result = await runMixtapeOutput({
        payload: payload || {},
        onProgress: sendProgress
      })
      sendProgress({
        stageKey: 'mixtape.outputProgressFinished',
        done: 100,
        total: 100,
        percent: 100
      })
      return {
        ok: true,
        ...result
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '导出失败')
      sendProgress({
        stageKey: 'mixtape.outputProgressFailed',
        done: 100,
        total: 100,
        percent: 100
      })
      log.error('[mixtape-output] export failed', { message, error })
      return {
        ok: false,
        error: message
      }
    }
  })

  ipcMain.handle(
    'mixtape:update-grid-definition',
    async (
      _e,
      payload: { filePath?: string; barBeatOffset?: number; firstBeatMs?: number; bpm?: number }
    ) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const rawOffset = Number(payload?.barBeatOffset)
      const rawFirstBeatMs = Number(payload?.firstBeatMs)
      const rawBpm = Number(payload?.bpm)
      const hasOffset = Number.isFinite(rawOffset)
      const hasFirstBeatMs = Number.isFinite(rawFirstBeatMs)
      const hasBpm = Number.isFinite(rawBpm) && rawBpm > 0
      if (!filePath || (!hasOffset && !hasFirstBeatMs && !hasBpm)) {
        return { updated: 0 }
      }
      return upsertMixtapeItemGridByFilePath([
        {
          filePath,
          barBeatOffset: hasOffset ? rawOffset : 0,
          firstBeatMs: hasFirstBeatMs ? rawFirstBeatMs : undefined,
          bpm: hasBpm ? rawBpm : undefined
        }
      ])
    }
  )

  ipcMain.handle(
    'mixtape:update-gain-envelope',
    async (
      _e,
      payload?: {
        entries?: Array<{ itemId?: string; gainEnvelope?: Array<{ sec?: number; gain?: number }> }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemGainEnvelopeById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          gainEnvelope: Array.isArray(item?.gainEnvelope)
            ? item.gainEnvelope
                .map((point) => ({
                  sec: Number(point?.sec),
                  gain: Number(point?.gain)
                }))
                .filter(
                  (point) =>
                    Number.isFinite(point.sec) &&
                    point.sec >= 0 &&
                    Number.isFinite(point.gain) &&
                    point.gain > 0
                )
            : []
        }))
      )
    }
  )

  ipcMain.handle(
    'mixtape:update-mix-envelope',
    async (
      _e,
      payload?: {
        param?: string
        entries?: Array<{ itemId?: string; gainEnvelope?: Array<{ sec?: number; gain?: number }> }>
      }
    ) => {
      const paramRaw = typeof payload?.param === 'string' ? payload.param.trim() : ''
      const supportedParams = new Set([
        'gain',
        'high',
        'mid',
        'low',
        'vocal',
        'inst',
        'bass',
        'drums',
        'volume'
      ])
      if (!supportedParams.has(paramRaw)) {
        return { updated: 0 }
      }
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemMixEnvelopeById(
        paramRaw as
          | 'gain'
          | 'high'
          | 'mid'
          | 'low'
          | 'vocal'
          | 'inst'
          | 'bass'
          | 'drums'
          | 'volume',
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          gainEnvelope: Array.isArray(item?.gainEnvelope)
            ? item.gainEnvelope
                .map((point) => ({
                  sec: Number(point?.sec),
                  gain: Number(point?.gain)
                }))
                .filter(
                  (point) =>
                    Number.isFinite(point.sec) &&
                    point.sec >= 0 &&
                    Number.isFinite(point.gain) &&
                    point.gain > 0
                )
            : []
        }))
      )
    }
  )

  ipcMain.handle(
    'mixtape:update-volume-mute-segments',
    async (
      _e,
      payload?: {
        entries?: Array<{
          itemId?: string
          segments?: Array<{ startSec?: number; endSec?: number }>
        }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemVolumeMuteSegmentsById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          segments: Array.isArray(item?.segments)
            ? item.segments
                .map((segment) => ({
                  startSec: Number(segment?.startSec),
                  endSec: Number(segment?.endSec)
                }))
                .filter(
                  (segment) =>
                    Number.isFinite(segment.startSec) &&
                    segment.startSec >= 0 &&
                    Number.isFinite(segment.endSec) &&
                    segment.endSec > segment.startSec
                )
            : []
        }))
      )
    }
  )

  ipcMain.handle(
    'mixtape:update-track-start-sec',
    async (
      _e,
      payload?: {
        entries?: Array<{
          itemId?: string
          startSec?: number
          bpm?: number
          masterTempo?: boolean
          originalBpm?: number
        }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemStartSecById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          startSec: Number(item?.startSec),
          bpm: Number(item?.bpm),
          masterTempo: typeof item?.masterTempo === 'boolean' ? item.masterTempo : undefined,
          originalBpm: Number(item?.originalBpm)
        }))
      )
    }
  )
}
