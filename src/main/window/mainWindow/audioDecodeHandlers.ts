import { ipcMain, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../log'
import { findSongListRoot } from '../../services/cacheMaintenance'
import { enqueueKeyAnalysis } from '../../services/keyAnalysisQueue'
import {
  isCompleteSharedSongGridDefinition,
  loadSharedSongGridDefinition
} from '../../services/sharedSongGrid'
import { decodeAudioShared } from '../../services/audioDecodePool'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../../services/songInfoLite'
import { isInRecordingLibraryAbsPath } from '../../recordingLibraryService'
import { COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE } from '../../../shared/compactVisualWaveform'
import {
  buildUnifiedDisplayWaveformDetailFromMixxx,
  UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE
} from '../../../shared/unifiedDisplayWaveform'
import {
  buildWaveformSurfaceCacheDataFromUnifiedDisplay,
  type WaveformGlobalOverviewData
} from '../../../shared/waveformSurfaceCache'

type DecodeRequestOptions = {
  analysisAuthority?: 'frkb'
  skipPlaybackGridAnalysis?: boolean
  suppressFrkbWaveformData?: boolean
}

const clonePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) {
    return new Float32Array(0)
  }
  if (pcmData instanceof Float32Array) {
    return new Float32Array(pcmData)
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(pcmData)) {
    const buffer = pcmData as Buffer
    const view = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 4)
    )
    return new Float32Array(view)
  }
  if (pcmData instanceof Uint8Array) {
    const view = new Float32Array(
      pcmData.buffer,
      pcmData.byteOffset,
      Math.floor(pcmData.byteLength / 4)
    )
    return new Float32Array(view)
  }
  return new Float32Array(0)
}

const enqueuePlaybackGridAnalysis = (filePath: string, focusSlot?: string) => {
  enqueueKeyAnalysis(filePath, focusSlot ? 'high' : 'medium', {
    urgent: Boolean(focusSlot),
    source: 'foreground',
    focusSlot
  })
}

export function registerAudioDecodeHandlers(getWindow: () => BrowserWindow | null) {
  const handleDecode =
    (eventName: 'readSongFile' | 'readNextSongFile', successEvent: string, errorEvent: string) =>
    async (
      _e: Electron.IpcMainEvent,
      filePath: string,
      requestId: string,
      options?: DecodeRequestOptions
    ) => {
      try {
        const permitsFrkbAnalysis =
          options?.analysisAuthority === 'frkb' && options?.suppressFrkbWaveformData !== true
        const sharedGrid = permitsFrkbAnalysis
          ? await loadSharedSongGridDefinition(filePath).catch(() => null)
          : null
        const needsGridAnalysis =
          permitsFrkbAnalysis &&
          options?.skipPlaybackGridAnalysis !== true &&
          !isInRecordingLibraryAbsPath(filePath) &&
          !isCompleteSharedSongGridDefinition(sharedGrid)
        if (needsGridAnalysis) {
          enqueuePlaybackGridAnalysis(
            filePath,
            eventName === 'readSongFile' ? 'main-player' : undefined
          )
        }
        let stat: { size: number; mtimeMs: number } | null = null
        try {
          const fsStat = await fs.stat(filePath)
          stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
        } catch {}

        const listRoot = options?.suppressFrkbWaveformData
          ? ''
          : await findSongListRoot(path.dirname(filePath))
        let compactVisualWaveformData: WaveformGlobalOverviewData | null = null
        if (stat && listRoot) {
          compactVisualWaveformData =
            (await LibraryCacheDb.loadWaveformGlobalOverviewCacheData(listRoot, filePath, stat)) ??
            null
          await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        }

        const shouldBuildUnifiedDisplayWaveform = !compactVisualWaveformData && Boolean(listRoot)
        const result = await decodeAudioShared(filePath, {
          analyzeKey: false,
          needWaveform: shouldBuildUnifiedDisplayWaveform,
          waveformTargetRate: UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE,
          needRawWaveform: shouldBuildUnifiedDisplayWaveform,
          rawTargetRate: COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE,
          fileStat: stat,
          traceLabel: eventName,
          priority: 'high',
          queueKey: eventName,
          replaceQueued: true
        })
        if (shouldBuildUnifiedDisplayWaveform && result.mixxxWaveformData && listRoot && stat) {
          const cachedEntry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
          if (!cachedEntry) {
            const info = applyLiteDefaults(buildLiteSongInfo(filePath), filePath)
            await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              info
            })
          }
          const unified = result.rawWaveformData
            ? buildUnifiedDisplayWaveformDetailFromMixxx(
                result.mixxxWaveformData,
                result.rawWaveformData
              )
            : null
          const surfaceData = buildWaveformSurfaceCacheDataFromUnifiedDisplay(unified)
          compactVisualWaveformData = surfaceData?.globalOverview ?? null
          await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
          if (unified && surfaceData) {
            await LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(
              listRoot,
              filePath,
              { size: stat.size, mtimeMs: stat.mtimeMs },
              unified
            )
            await LibraryCacheDb.upsertWaveformSurfaceCacheEntry(
              listRoot,
              filePath,
              { size: stat.size, mtimeMs: stat.mtimeMs },
              surfaceData
            )
          } else {
            await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
            await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, filePath)
          }
        }
        const payload = {
          pcmData: clonePcmData(result.pcmData),
          sampleRate: result.sampleRate,
          channels: result.channels,
          totalFrames: result.totalFrames,
          compactVisualWaveformData
        }
        getWindow()?.webContents.send(successEvent, payload, filePath, requestId)
      } catch (error) {
        const errorMsg = `解码歌曲文件失败(${eventName}) ${filePath}`
        log.error(errorMsg, error)
        getWindow()?.webContents.send(errorEvent, filePath, (error as Error).message, requestId)
      }
    }

  const handlePreviewDecode = async (
    _e: Electron.IpcMainEvent,
    filePath: string,
    requestId: string
  ) => {
    try {
      const result = await decodeAudioShared(filePath, {
        analyzeKey: false,
        needWaveform: false,
        needRawWaveform: false,
        traceLabel: 'readPreviewSongFile',
        priority: 'high',
        queueKey: 'readPreviewSongFile',
        replaceQueued: true
      })
      const payload = {
        pcmData: clonePcmData(result.pcmData),
        sampleRate: result.sampleRate,
        channels: result.channels,
        totalFrames: result.totalFrames
      }
      getWindow()?.webContents.send('readedPreviewSongFile', payload, filePath, requestId)
    } catch (error) {
      const errorMsg = `解码预览文件失败 ${filePath}`
      log.error(errorMsg, error)
      getWindow()?.webContents.send(
        'readPreviewSongFileError',
        filePath,
        (error as Error).message,
        requestId
      )
    }
  }

  // 混音时间轴播放解码：所有格式统一通过后端 Rust/FFmpeg 解码为 PCM
  // 使用 invoke 模式，渲染进程可 await 结果
  ipcMain.handle(
    'mixtape:decode-for-transport',
    async (
      _e,
      filePath: string
    ): Promise<{
      pcmData: unknown
      sampleRate: number
      channels: number
      totalFrames: number
    }> => {
      const result = await decodeAudioShared(filePath, {
        analyzeKey: false,
        needWaveform: false,
        needRawWaveform: false,
        traceLabel: 'mixtape:decode-for-transport',
        priority: 'high'
      })
      return {
        pcmData: result.pcmData,
        sampleRate: result.sampleRate,
        channels: result.channels,
        totalFrames: result.totalFrames
      }
    }
  )

  ipcMain.on('readSongFile', handleDecode('readSongFile', 'readedSongFile', 'readSongFileError'))
  ipcMain.on(
    'readNextSongFile',
    handleDecode('readNextSongFile', 'readedNextSongFile', 'readNextSongFileError')
  )
  ipcMain.on('readPreviewSongFile', handlePreviewDecode)
}
