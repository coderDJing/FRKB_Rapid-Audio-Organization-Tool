import { ipcMain, type BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../../store'
import FingerprintStore from '../../fingerprintStore'
import { collectFilesWithExtensions, getSongsAnalyseResult } from '../../utils'
import type { SendProgress } from './progress'

interface RegisterFingerprintHandlersOptions {
  sendProgress: SendProgress
  getWindow: () => BrowserWindow | null
}

export function registerFingerprintHandlers({
  sendProgress,
  getWindow
}: RegisterFingerprintHandlersOptions) {
  ipcMain.on('addSongFingerprint', async (_e, folderPath: string[]) => {
    const progressId = `fingerprints_${Date.now()}`
    const fingerprintStartAt = Date.now()
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.scanningFiles',
      now: 0,
      total: 1,
      isInitial: true
    })
    const songFileUrls = (
      await Promise.all(
        folderPath.map((item) => collectFilesWithExtensions(item, store.settingConfig.audioExt))
      )
    ).flat()
    sendProgress({ id: progressId, titleKey: 'fingerprints.scanningFiles', now: 1, total: 1 })
    if (songFileUrls.length === 0) {
      getWindow()?.webContents.send('noAudioFileWasScanned', progressId)
      return
    }
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.analyzeInit',
      now: 0,
      total: songFileUrls.length
    })
    const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
      songFileUrls,
      (resultLength: number) => {
        sendProgress({
          id: progressId,
          titleKey: 'fingerprints.analyzingFingerprints',
          now: resultLength,
          total: songFileUrls.length
        })
      }
    )
    const uniqueFingerprints = new Set(songsAnalyseResult.map((item) => item.sha256_Hash))
    const removeDuplicatesFingerprintResults = Array.from(uniqueFingerprints)
    const beforeSongFingerprintListLength = store.songFingerprintList.length
    store.songFingerprintList = Array.from(
      new Set([...store.songFingerprintList, ...removeDuplicatesFingerprintResults])
    )
    await FingerprintStore.saveList(
      store.songFingerprintList,
      ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    )
    const fingerprintEndAt = Date.now()
    const duplicatesRemovedCount =
      songFileUrls.length -
      (store.songFingerprintList.length - beforeSongFingerprintListLength) -
      errorSongsAnalyseResult.length
    const fingerprintSummary = {
      startAt: new Date(fingerprintStartAt).toISOString(),
      endAt: new Date(fingerprintEndAt).toISOString(),
      durationMs: fingerprintEndAt - fingerprintStartAt,
      scannedCount: songFileUrls.length,
      analyzeFailedCount: errorSongsAnalyseResult.length,
      duplicatesRemovedCount,
      fingerprintAddedCount: store.songFingerprintList.length - beforeSongFingerprintListLength,
      fingerprintTotalBefore: beforeSongFingerprintListLength,
      fingerprintTotalAfter: store.songFingerprintList.length,
      fingerprintMode: ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    }
    getWindow()?.webContents.send('addSongFingerprintFinished', fingerprintSummary, progressId)
  })

  ipcMain.handle('fingerprints:addExistingFromPaths', async (_event, payload) => {
    const rawInput = Array.isArray(payload?.filePaths) ? (payload.filePaths as unknown[]) : []
    const normalizedPaths: string[] = Array.from(
      new Set(
        rawInput
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map((p) => path.normalize(p))
      )
    )
    const audioExts = new Set(
      (store.settingConfig?.audioExt || []).map((ext: string) => ext.toLowerCase())
    )
    const eligibilityResults = await Promise.all(
      normalizedPaths.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath)
          if (!stats.isFile()) return null
          const ext = path.extname(filePath).toLowerCase()
          if (!audioExts.has(ext)) return null
          return filePath
        } catch {
          return null
        }
      })
    )
    const eligiblePaths = eligibilityResults.filter((p): p is string => typeof p === 'string')
    if (eligiblePaths.length === 0) {
      throw new Error('NO_ELIGIBLE_AUDIO')
    }
    const progressId = `fingerprints_${Date.now()}`
    const fingerprintStartAt = Date.now()
    const finalize = (summary: any | null) => {
      getWindow()?.webContents.send('fingerprints:addExistingFinished', summary, progressId)
    }
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.scanningFiles',
      now: 0,
      total: 1,
      isInitial: true
    })
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.scanningFiles',
      now: 1,
      total: 1
    })
    try {
      sendProgress({
        id: progressId,
        titleKey: 'fingerprints.analyzeInit',
        now: 0,
        total: eligiblePaths.length
      })
      const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
        eligiblePaths,
        (resultLength: number) => {
          sendProgress({
            id: progressId,
            titleKey: 'fingerprints.analyzingFingerprints',
            now: resultLength,
            total: eligiblePaths.length
          })
        }
      )
      const fingerprintMode =
        ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
      const beforeSongFingerprintListLength = store.songFingerprintList.length
      const fingerprintSet = new Set(store.songFingerprintList)
      const uniqueFingerprints = Array.from(
        new Set(
          songsAnalyseResult
            .map((item) => item?.sha256_Hash)
            .filter((sha): sha is string => typeof sha === 'string' && sha.length > 0)
        )
      )
      let fingerprintAlreadyExistingCount = 0
      for (const fingerprint of uniqueFingerprints) {
        if (fingerprintSet.has(fingerprint)) {
          fingerprintAlreadyExistingCount++
        } else {
          fingerprintSet.add(fingerprint)
        }
      }
      store.songFingerprintList = Array.from(fingerprintSet)
      await FingerprintStore.saveList(store.songFingerprintList, fingerprintMode)
      const fingerprintEndAt = Date.now()
      const fingerprintAddedCount =
        store.songFingerprintList.length - beforeSongFingerprintListLength
      const duplicatesRemovedCount = Math.max(
        0,
        songsAnalyseResult.length - uniqueFingerprints.length
      )
      const errorCount = Array.isArray(errorSongsAnalyseResult) ? errorSongsAnalyseResult.length : 0
      const summary = {
        startAt: new Date(fingerprintStartAt).toISOString(),
        endAt: new Date(fingerprintEndAt).toISOString(),
        durationMs: fingerprintEndAt - fingerprintStartAt,
        scannedCount: eligiblePaths.length,
        analyzeFailedCount: errorCount,
        importedToPlaylistCount: 0,
        duplicatesRemovedCount,
        fingerprintAddedCount,
        fingerprintAlreadyExistingCount,
        fingerprintTotalBefore: beforeSongFingerprintListLength,
        fingerprintTotalAfter: store.songFingerprintList.length,
        isComparisonSongFingerprint: false,
        isPushSongFingerprintLibrary: true,
        hideOverviewSection: true
      }
      finalize(summary)
      return { ok: true }
    } catch (error) {
      finalize(null)
      throw error
    }
  })
}
