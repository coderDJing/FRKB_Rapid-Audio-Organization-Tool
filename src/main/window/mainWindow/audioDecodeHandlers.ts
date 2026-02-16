import { ipcMain, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../log'
import { findSongListRoot } from '../../services/cacheMaintenance'
import { enqueueKeyAnalysis, enqueueKeyAnalysisImmediate } from '../../services/keyAnalysisQueue'
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
        if (eventName === 'readSongFile') {
          enqueueKeyAnalysisImmediate(filePath)
        } else {
          enqueueKeyAnalysis(filePath, 'high')
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
          traceLabel: eventName
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
        console.error(`${errorMsg}:`, error)
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
        traceLabel: 'readPreviewSongFile'
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
      console.error(`${errorMsg}:`, error)
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
      pcmData: Float32Array
      sampleRate: number
      channels: number
      totalFrames: number
    }> => {
      const result = await decodeAudioShared(filePath, {
        analyzeKey: false,
        needWaveform: false,
        needRawWaveform: false,
        traceLabel: 'mixtape:decode-for-transport'
      })
      return {
        pcmData: clonePcmData(result.pcmData),
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
