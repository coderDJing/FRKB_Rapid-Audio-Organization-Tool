import { ipcMain } from 'electron'
import store from '../store'
import {
  cancelCuratedLibrarySync,
  isCuratedLibrarySyncRunning,
  runCuratedLibrarySync
} from './engine'
import { fetchCuratedLibraryStatus } from './apiClient'
import { isCuratedLibraryLiveConnected } from './liveSync'
import {
  readCuratedLibrarySyncConflicts,
  readCuratedLibrarySyncFailures,
  readCuratedLibrarySyncQuotaCache,
  writeCuratedLibrarySyncConflicts,
  writeCuratedLibrarySyncFailures,
  writeCuratedLibrarySyncQuotaCache
} from '../librarySettingsDb'
import { parseConflictItems, parseFailureItems } from './reports'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import type {
  CuratedLibrarySyncOverview,
  CuratedLibrarySyncStartPayload
} from '../../shared/curatedLibrarySync'

let queued: Promise<unknown> = Promise.resolve()

export const enqueueCloudWork = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = queued.then(task, task)
  queued = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export const enqueueCuratedLibrarySync = (
  payload?: CuratedLibrarySyncStartPayload
): Promise<Awaited<ReturnType<typeof runCuratedLibrarySync>>> =>
  enqueueCloudWork(() => runCuratedLibrarySync(payload))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readQuotaCache = () => {
  const raw = readCuratedLibrarySyncQuotaCache()
  if (!isRecord(raw)) {
    return {
      quotaUsedBytes: 0,
      quotaBytes: 0,
      fileCount: 0,
      revision: 0,
      snapshotReady: false
    }
  }
  return {
    quotaUsedBytes: Number(raw.quotaUsedBytes) || 0,
    quotaBytes: Number(raw.quotaBytes) || 0,
    fileCount: Number(raw.fileCount) || 0,
    revision: Number(raw.revision) || 0,
    snapshotReady: raw.snapshotReady === true
  }
}

const buildOverview = async (): Promise<CuratedLibrarySyncOverview> => {
  const cached = readQuotaCache()
  const conflicts = parseConflictItems(readCuratedLibrarySyncConflicts())
  const failures = parseFailureItems(readCuratedLibrarySyncFailures())
  const userKey = resolveDevCloudSyncUserKey(
    String(store.settingConfig?.cloudSyncUserKey || '').trim(),
    is.dev
  )
  if (!userKey) {
    return {
      liveConnected: false,
      snapshotReady: cached.snapshotReady,
      revision: cached.revision,
      fileCount: cached.fileCount,
      quotaUsedBytes: cached.quotaUsedBytes,
      quotaBytes: cached.quotaBytes,
      conflicts,
      failures
    }
  }
  try {
    const status = await fetchCuratedLibraryStatus()
    writeCuratedLibrarySyncQuotaCache({
      quotaUsedBytes: status.blobBytes,
      quotaBytes: status.quotaBytes,
      fileCount: status.fileCount,
      revision: status.revision,
      snapshotReady: status.snapshotReady
    })
    return {
      liveConnected: isCuratedLibraryLiveConnected(),
      snapshotReady: status.snapshotReady,
      revision: status.revision,
      fileCount: status.fileCount,
      quotaUsedBytes: status.blobBytes,
      quotaBytes: status.quotaBytes,
      conflicts,
      failures
    }
  } catch {
    return {
      liveConnected: isCuratedLibraryLiveConnected(),
      snapshotReady: cached.snapshotReady,
      revision: cached.revision,
      fileCount: cached.fileCount,
      quotaUsedBytes: cached.quotaUsedBytes,
      quotaBytes: cached.quotaBytes,
      conflicts,
      failures
    }
  }
}

export const registerCuratedLibrarySyncIpc = (): void => {
  ipcMain.handle(
    'curatedLibrarySync/start',
    async (_event, payload?: CuratedLibrarySyncStartPayload) => {
      return enqueueCuratedLibrarySync(payload)
    }
  )
  ipcMain.handle('curatedLibrarySync/cancel', async () => cancelCuratedLibrarySync())
  ipcMain.handle('curatedLibrarySync/isRunning', () => isCuratedLibrarySyncRunning())
  ipcMain.handle('curatedLibrarySync/isLiveConnected', () => isCuratedLibraryLiveConnected())
  ipcMain.handle('curatedLibrarySync/getOverview', () => buildOverview())
  ipcMain.handle('curatedLibrarySync/clearConflicts', () => {
    writeCuratedLibrarySyncConflicts([])
    return { ok: true }
  })
  ipcMain.handle('curatedLibrarySync/clearFailures', () => {
    writeCuratedLibrarySyncFailures([])
    return { ok: true }
  })
  ipcMain.handle('curatedLibrarySync/retryFailures', async () => {
    return enqueueCuratedLibrarySync({ trigger: 'manual' })
  })
}
