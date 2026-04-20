import { ipcMain, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../log'
import { findSongListRoot } from '../../services/cacheMaintenance'
import { enqueueKeyAnalysis, enqueueKeyAnalysisImmediate } from '../../services/keyAnalysisQueue'
import {
  isCompleteSharedSongGridDefinition,
  loadSharedSongGridDefinition
} from '../../services/sharedSongGrid'
import { decodeAudioShared } from '../../services/audioDecodePool'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../../services/songInfoLite'
import type { MixxxWaveformData } from '../../waveformCache'

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

export function registerAudioDecodeHandlers(getWindow: () => BrowserWindow | null) {
  const handleDecode =
    (eventName: 'readSongFile' | 'readNextSongFile', successEvent: string, errorEvent: string) =>
    async (_e: Electron.IpcMainEvent, filePath: string, requestId: string) => {
      try {
        const sharedGrid = await loadSharedSongGridDefinition(filePath).catch(() => null)
        const needsGridAnalysis = !isCompleteSharedSongGridDefinition(sharedGrid)
        if (needsGridAnalysis) {
          if (eventName === 'readSongFile') {
            enqueueKeyAnalysisImmediate(filePath)
          } else {
            enqueueKeyAnalysis(filePath, 'high')
          }
        }
        let stat: { size: number; mtimeMs: number } | null = null
        try {
          const fsStat = await fs.stat(filePath)
          stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
        } catch {}

        const listRoot = await findSongListRoot(path.dirname(filePath))
        let cachedWaveform: MixxxWaveformData | null = null
        if (stat && listRoot) {
          const cached = await LibraryCacheDb.loadWaveformCacheData(listRoot, filePath, stat)
          if (cached) {
            cachedWaveform = cached
          }
        }

        const result = await decodeAudioShared(filePath, {
          analyzeKey: false,
          needWaveform: !cachedWaveform,
          fileStat: stat,
          traceLabel: eventName,
          priority: 'high'
        })
        const mixxxWaveformData = cachedWaveform ?? result.mixxxWaveformData ?? null
        if (!cachedWaveform && mixxxWaveformData && listRoot && stat) {
          const cachedEntry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
          if (!cachedEntry) {
            const info = applyLiteDefaults(buildLiteSongInfo(filePath), filePath)
            await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              info
            })
          }
          await LibraryCacheDb.upsertWaveformCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            mixxxWaveformData
          )
        }
        const payload = {
          pcmData: clonePcmData(result.pcmData),
          sampleRate: result.sampleRate,
          channels: result.channels,
          totalFrames: result.totalFrames,
          mixxxWaveformData
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
        priority: 'high'
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

  ipcMain.handle(
    'mixtape:process-soundtouch-pcm',
    async (
      _e,
      payload?: {
        pcmData?: unknown
        sampleRate?: number
        channels?: number
        tempoRatio?: number
      }
    ): Promise<{
      pcmData: unknown
      sampleRate: number
      channels: number
      totalFrames: number
      error?: string
    }> => {
      try {
        const binding = require('rust_package') as {
          processSoundtouchPcm?: (
            pcmData: Buffer,
            sampleRate: number,
            channels: number,
            tempoRatio: number
          ) => {
            pcmData?: unknown
            sampleRate?: number
            channels?: number
            totalFrames?: number
            error?: string
          }
        }
        if (typeof binding.processSoundtouchPcm !== 'function') {
          return {
            pcmData: new Uint8Array(0),
            sampleRate: Number(payload?.sampleRate) || 44100,
            channels: Math.max(1, Number(payload?.channels) || 1),
            totalFrames: 0,
            error: 'rust_package.processSoundtouchPcm unavailable'
          }
        }
        const pcmData = clonePcmData(payload?.pcmData)
        const pcmBuffer = Buffer.from(
          pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength)
        )
        const result = binding.processSoundtouchPcm(
          pcmBuffer,
          Number(payload?.sampleRate) || 44100,
          Math.max(1, Number(payload?.channels) || 1),
          Number(payload?.tempoRatio) || 1
        )
        return {
          pcmData: result?.pcmData ?? new Uint8Array(0),
          sampleRate: Number(result?.sampleRate) || Number(payload?.sampleRate) || 44100,
          channels: Math.max(1, Number(result?.channels) || Number(payload?.channels) || 1),
          totalFrames: Math.max(0, Number(result?.totalFrames) || 0),
          error: result?.error ? String(result.error) : undefined
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('[mixtape] process soundtouch pcm failed', { error: message })
        return {
          pcmData: new Uint8Array(0),
          sampleRate: Number(payload?.sampleRate) || 44100,
          channels: Math.max(1, Number(payload?.channels) || 1),
          totalFrames: 0,
          error: message
        }
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
