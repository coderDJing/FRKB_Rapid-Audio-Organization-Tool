import { powerMonitor } from 'electron'
import store from '../store'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import { isLibraryMergeActive } from '../services/libraryMerge'
import { isLibraryRelocateActive, hasLibraryRelocateJournalSync } from '../services/libraryRelocate'
import { beginLibraryTreeWatcherBulkOperation } from '../libraryTreeWatcher'
import { getLibrary } from '../utils'
import { runPlaybackAwareBackgroundFileIo } from '../services/playbackForegroundActivity'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import {
  getCuratedLibrarySyncLastAppliedRevision,
  isCuratedLibrarySyncEnabled,
  readCuratedLibrarySyncDeferredOps,
  readCuratedLibrarySyncLastCloudIds,
  writeCuratedLibrarySyncDeferredOps,
  writeCuratedLibrarySyncLastCloudIds,
  readCuratedLibrarySyncLastSnapshot,
  writeCuratedLibrarySyncLastSnapshot,
  writeCuratedLibrarySyncConflicts,
  writeCuratedLibrarySyncFailures,
  writeCuratedLibrarySyncQuotaCache,
  setCuratedLibrarySyncLastAppliedRevision
} from '../librarySettingsDb'
import {
  CURATED_LIBRARY_SYNC_CANCEL_CHANNEL,
  CURATED_LIBRARY_SYNC_PROGRESS_ID,
  type CuratedLibrarySyncConflictItem,
  type CuratedLibrarySyncFailureItem,
  type CuratedLibrarySyncJoinMode,
  type CuratedLibrarySyncOp,
  type CuratedLibrarySyncSnapshot,
  type CuratedLibrarySyncStartPayload,
  type CuratedLibrarySyncStartResult,
  type CuratedLibrarySyncTrigger
} from '../../shared/curatedLibrarySync'
import {
  beginBlobUpload,
  beginFirstCuratedSnapshot,
  commitFirstCuratedSnapshot,
  fetchCuratedLibraryStatus,
  pullCuratedSnapshot,
  pushCuratedOps,
  replaceCuratedSnapshot
} from './apiClient'
import { uploadBlobWithResume } from './blobTransfer'
import { collectDroppedOps } from './conflictDiff'
import { mapTransferErrorKey } from './reports'
import { parseCuratedLibrarySnapshot, mergeCuratedLibrarySnapshot } from './snapshotMerge'
import {
  applyRemoteSnapshot,
  buildCloudEntitiesFromLocal,
  diffLocalAgainstSnapshot,
  retryDeferredRemoteOps,
  type ApplyRemoteContext,
  type DeferredRemoteOp
} from './applyRemote'
import { scanCuratedLibraryForSync, type CuratedLocalFile } from './scan'

let running = false
let cancelRequested = false
let abortController: AbortController | null = null
let suspendPaused = false
let resumeWaiters: Array<() => void> = []
let powerMonitorBound = false
let sessionFailures: CuratedLibrarySyncFailureItem[] = []
let sessionConflicts: CuratedLibrarySyncConflictItem[] = []
let sessionAttemptedTransfers = false
let sessionCompletedWork = false

const bindPowerMonitor = () => {
  if (powerMonitorBound) return
  powerMonitorBound = true
  powerMonitor.on('suspend', () => {
    suspendPaused = true
    abortController?.abort()
  })
  powerMonitor.on('resume', () => {
    suspendPaused = false
    for (const waiter of resumeWaiters) waiter()
    resumeWaiters = []
  })
}

const waitIfSuspended = async () => {
  if (!suspendPaused) return
  await new Promise<void>((resolve) => {
    resumeWaiters.push(resolve)
  })
}

const recordFailure = (item: Omit<CuratedLibrarySyncFailureItem, 'atMs'> & { atMs?: number }) => {
  sessionFailures.push({
    ...item,
    atMs: item.atMs || Date.now()
  })
}

const cacheQuotaFromStatus = (status: {
  blobBytes: number
  quotaBytes?: number
  fileCount: number
  revision: number
  snapshotReady: boolean
}) => {
  writeCuratedLibrarySyncQuotaCache({
    quotaUsedBytes: status.blobBytes,
    quotaBytes: Number(status.quotaBytes) || 0,
    fileCount: status.fileCount,
    revision: status.revision,
    snapshotReady: status.snapshotReady
  })
}

const emitSyncNotice = () => {
  if (sessionConflicts.length === 0 && sessionFailures.length === 0) return
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('curatedLibrarySync/notice', {
    kind: sessionConflicts.length > 0 ? 'conflicts' : 'failures',
    conflictCount: sessionConflicts.length,
    failureCount: sessionFailures.length
  })
}

const persistSessionReports = (keepPrevious: boolean) => {
  if (!keepPrevious) {
    writeCuratedLibrarySyncConflicts(sessionConflicts)
    writeCuratedLibrarySyncFailures(sessionFailures)
    return
  }
  if (sessionConflicts.length > 0) writeCuratedLibrarySyncConflicts(sessionConflicts)
  if (sessionFailures.length > 0) writeCuratedLibrarySyncFailures(sessionFailures)
}

const sendProgress = (
  titleKey: string,
  now: number,
  total: number,
  extra?: Record<string, unknown>
) => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('progressSet', {
    id: CURATED_LIBRARY_SYNC_PROGRESS_ID,
    titleKey,
    now,
    total,
    cancelable: true,
    cancelChannel: CURATED_LIBRARY_SYNC_CANCEL_CHANNEL,
    ...extra
  })
}

const dismissProgress = () => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('progressSet', {
    id: CURATED_LIBRARY_SYNC_PROGRESS_ID,
    dismiss: true
  })
}

const notifyTree = async () => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  try {
    const tree = await getLibrary({ skipSync: true })
    win.webContents.send('library-tree-updated', tree)
  } catch {}
}

const throwIfCancelled = () => {
  if (cancelRequested) {
    const error = new Error('CURATED_SYNC_CANCELLED')
    error.name = 'AbortError'
    throw error
  }
}

const toDeferred = (value: unknown): DeferredRemoteOp[] => {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is DeferredRemoteOp => {
    if (!item || typeof item !== 'object') return false
    const type = (item as DeferredRemoteOp).type
    return type === 'deleteFile' || type === 'moveFile' || type === 'deleteNode'
  })
}

const uploadMissingBlobs = async (files: CuratedLocalFile[]): Promise<Set<string>> => {
  const seen = new Set<string>()
  const failed = new Set<string>()
  let index = 0
  sessionAttemptedTransfers = true
  for (const file of files) {
    throwIfCancelled()
    await waitIfSuspended()
    if (seen.has(file.contentSha256)) continue
    seen.add(file.contentSha256)
    sendProgress('cloudSync.curatedLibrary.progressUploading', index, files.length)
    index += 1
    try {
      const begin = await beginBlobUpload({ sha256: file.contentSha256, size: file.contentSize })
      if (!begin.needed) continue
      abortController = new AbortController()
      try {
        await runPlaybackAwareBackgroundFileIo(
          'curated-library-sync:upload-blob',
          { filePath: file.absPath },
          () =>
            uploadBlobWithResume({
              sha256: file.contentSha256,
              filePath: file.absPath,
              size: file.contentSize,
              signal: abortController?.signal,
              onSuspendWait: waitIfSuspended,
              throwIfCancelled
            })
        )
      } catch (error) {
        if (suspendPaused) {
          await waitIfSuspended()
          abortController = new AbortController()
          await uploadBlobWithResume({
            sha256: file.contentSha256,
            filePath: file.absPath,
            size: file.contentSize,
            signal: abortController.signal,
            onSuspendWait: waitIfSuspended,
            throwIfCancelled
          })
          continue
        }
        throw error
      }
    } catch (error) {
      if (cancelRequested || (error as { name?: string })?.name === 'AbortError') throw error
      failed.add(file.contentSha256)
      recordFailure({
        direction: 'upload',
        name: file.fileName,
        sha256: file.contentSha256,
        fileId: file.fileId,
        errorKey: mapTransferErrorKey(error)
      })
    }
  }
  return failed
}

const omitFailedBlobOps = (
  ops: CuratedLibrarySyncOp[],
  failedSha: Set<string>
): CuratedLibrarySyncOp[] => {
  if (failedSha.size === 0) return ops
  return ops.filter((op) => {
    if (op.type !== 'upsertFile' && op.type !== 'undeleteFile') return true
    return !failedSha.has(op.file.sha256)
  })
}

const rememberPushConflicts = (
  ops: CuratedLibrarySyncOp[],
  winning: CuratedLibrarySyncSnapshot
) => {
  const dropped = collectDroppedOps(ops, winning)
  if (dropped.length > 0) sessionConflicts = dropped
}

const buildPushOps = (
  local: Awaited<ReturnType<typeof scanCuratedLibraryForSync>>,
  snapshot: Awaited<ReturnType<typeof pullCuratedSnapshot>>
): CuratedLibrarySyncOp[] => {
  const diff = diffLocalAgainstSnapshot(local, snapshot)
  const ops: CuratedLibrarySyncOp[] = []
  const now = Date.now()
  for (const node of local.nodes) {
    const cloud = diff.cloudNodes.get(node.uuid)
    if (
      !cloud ||
      cloud.name !== node.name ||
      cloud.parentUuid !== node.parentUuid ||
      cloud.sortOrder !== node.sortOrder ||
      cloud.nodeType !== node.nodeType
    ) {
      ops.push({
        type: 'upsertNode',
        node: {
          uuid: node.uuid,
          parentUuid: node.parentUuid,
          name: node.name,
          nodeType: node.nodeType,
          sortOrder: node.sortOrder,
          updatedAtMs: now
        }
      })
    }
  }
  for (const file of local.files) {
    const cloud = diff.cloudFiles.get(file.fileId)
    if (
      !cloud ||
      cloud.parentUuid !== file.parentUuid ||
      cloud.fileName !== file.fileName ||
      cloud.sha256 !== file.contentSha256 ||
      cloud.trackNumber !== file.trackNumber ||
      cloud.addedAtMs !== file.addedAtMs
    ) {
      ops.push({
        type: 'upsertFile',
        file: {
          fileId: file.fileId,
          parentUuid: file.parentUuid,
          fileName: file.fileName,
          sha256: file.contentSha256,
          size: file.contentSize,
          trackNumber: file.trackNumber,
          addedAtMs: file.addedAtMs,
          updatedAtMs: now
        }
      })
    }
  }
  for (const [fileId] of diff.cloudFiles) {
    if (!diff.localFileIds.has(fileId)) {
      ops.push({ type: 'deleteFile', fileId, updatedAtMs: now })
    }
  }
  for (const [uuid] of diff.cloudNodes) {
    if (!diff.localNodeIds.has(uuid)) {
      ops.push({ type: 'deleteNode', uuid, updatedAtMs: now })
    }
  }
  for (const file of local.files) {
    const tombstone = diff.tombstoneFiles.get(file.fileId)
    if (!tombstone) continue
    if (file.updatedAtMs <= tombstone.deletedAtMs) continue
    ops.push({
      type: 'undeleteFile',
      file: {
        fileId: file.fileId,
        parentUuid: file.parentUuid,
        fileName: file.fileName,
        sha256: file.contentSha256,
        size: file.contentSize,
        trackNumber: file.trackNumber,
        addedAtMs: file.addedAtMs,
        updatedAtMs: now
      }
    })
  }
  return ops
}

const persistAppliedSnapshot = (snapshot: CuratedLibrarySyncSnapshot) => {
  setCuratedLibrarySyncLastAppliedRevision(snapshot.revision)
  writeCuratedLibrarySyncLastCloudIds({
    files: snapshot.files.map((file) => file.fileId),
    nodes: snapshot.nodes.map((node) => node.uuid)
  })
  writeCuratedLibrarySyncLastSnapshot({
    protocolVersion: snapshot.protocolVersion,
    revision: snapshot.revision,
    snapshotReady: snapshot.snapshotReady,
    full: true,
    nodes: snapshot.nodes,
    files: snapshot.files,
    tombstones: snapshot.tombstones
  })
}

const loadCachedSnapshot = () => parseCuratedLibrarySnapshot(readCuratedLibrarySyncLastSnapshot())

const pullMergedSnapshot = async (sinceRevision?: number | null) => {
  const cached = loadCachedSnapshot()
  const useDiff = cached != null && Number(sinceRevision) > 0
  const pulled = await pullCuratedSnapshot(useDiff ? sinceRevision : null)
  if (pulled.full === false && !cached) {
    const full = await pullCuratedSnapshot(null)
    return mergeCuratedLibrarySnapshot(null, full)
  }
  return mergeCuratedLibrarySnapshot(cached, pulled)
}

const waitForFirstSnapshotUnlock = async (): Promise<
  Awaited<ReturnType<typeof fetchCuratedLibraryStatus>>
> => {
  const deadline = Date.now() + 2 * 60 * 60 * 1000
  while (true) {
    throwIfCancelled()
    await waitIfSuspended()
    sendProgress('cloudSync.curatedLibrary.progressWaitingFirstSnapshot', 0, 1, {
      noProgress: true
    })
    const status = await fetchCuratedLibraryStatus()
    if (status.snapshotReady || !status.firstSnapshotLocked) return status
    if (Date.now() >= deadline) {
      throw new Error('CURATED_SYNC_FIRST_SNAPSHOT_WAIT_TIMEOUT')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
  }
}

const applyCtx = (onProgress = false): ApplyRemoteContext => ({
  signal: abortController?.signal || new AbortController().signal,
  onProgress: onProgress ? (titleKey, now, total) => sendProgress(titleKey, now, total) : undefined,
  onTransferFailure: (payload) => {
    sessionAttemptedTransfers = true
    recordFailure({
      direction: payload.direction,
      name: payload.name,
      sha256: payload.sha256,
      fileId: payload.fileId,
      errorKey: mapTransferErrorKey(payload.error)
    })
  }
})

const runJoin = async (
  mode: CuratedLibrarySyncJoinMode
): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  sendProgress('cloudSync.curatedLibrary.progressScanning', 0, 1, { noProgress: true })
  const local = await scanCuratedLibraryForSync()
  const snapshot = await pullMergedSnapshot(null)
  if (mode === 'local-wins') {
    const failedSha = await uploadMissingBlobs(local.files)
    const entities = buildCloudEntitiesFromLocal({
      ...local,
      files: local.files.filter((file) => !failedSha.has(file.contentSha256))
    })
    const next = await replaceCuratedSnapshot(entities)
    persistAppliedSnapshot(next)
    writeCuratedLibrarySyncDeferredOps([])
    return { status: 'success' }
  }
  const extras = mode === 'cloud-wins' ? 'delete' : 'keep'
  const release = beginLibraryTreeWatcherBulkOperation()
  try {
    const applied = await applyRemoteSnapshot(
      snapshot,
      local,
      {
        extras,
        adoptIds: true,
        applyTombstones: mode !== 'merge',
        knownFileIds: null,
        knownNodeIds: null
      },
      applyCtx(true)
    )
    if (applied.diskFull) return { status: 'disk_full' }
    writeCuratedLibrarySyncDeferredOps(applied.deferred)
    const after = await scanCuratedLibraryForSync()
    if (mode === 'merge') {
      const failedSha = await uploadMissingBlobs(after.files)
      const ops = omitFailedBlobOps(buildPushOps(after, snapshot), failedSha)
      if (ops.length > 0) {
        const pushed = await pushCuratedOps({ baseRevision: snapshot.revision, ops })
        if (!pushed.ok) {
          rememberPushConflicts(ops, pushed.snapshot)
          const conflictApplied = await applyRemoteSnapshot(
            pushed.snapshot,
            after,
            {
              extras: 'keep',
              adoptIds: true,
              applyTombstones: false,
              knownFileIds: null,
              knownNodeIds: null
            },
            applyCtx(true)
          )
          writeCuratedLibrarySyncDeferredOps([...applied.deferred, ...conflictApplied.deferred])
        }
        persistAppliedSnapshot(pushed.snapshot)
      } else {
        persistAppliedSnapshot(snapshot)
      }
    } else {
      persistAppliedSnapshot(snapshot)
    }
  } finally {
    release()
    await notifyTree()
  }
  return { status: 'success' }
}

const incrementalApplyOptions = () => {
  const lastIds = readCuratedLibrarySyncLastCloudIds()
  return {
    extras: 'keep' as const,
    adoptIds: false,
    applyTombstones: true,
    knownFileIds: lastIds ? new Set(lastIds.files) : null,
    knownNodeIds: lastIds ? new Set(lastIds.nodes) : null
  }
}

const runIncremental = async (): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  sendProgress('cloudSync.curatedLibrary.progressScanning', 0, 1, { noProgress: true })
  const local = await scanCuratedLibraryForSync()
  const snapshot = await pullMergedSnapshot(getCuratedLibrarySyncLastAppliedRevision())
  const release = beginLibraryTreeWatcherBulkOperation()
  try {
    const deferred = toDeferred(readCuratedLibrarySyncDeferredOps())
    const remainingDeferred = await retryDeferredRemoteOps(deferred, snapshot, applyCtx())
    const applied = await applyRemoteSnapshot(
      snapshot,
      local,
      incrementalApplyOptions(),
      applyCtx(true)
    )
    if (applied.diskFull) return { status: 'disk_full' }
    remainingDeferred.push(...applied.deferred)
    writeCuratedLibrarySyncDeferredOps(remainingDeferred)
    const after = await scanCuratedLibraryForSync()
    const failedSha = await uploadMissingBlobs(after.files)
    const ops = omitFailedBlobOps(buildPushOps(after, snapshot), failedSha)
    if (ops.length === 0) {
      persistAppliedSnapshot(snapshot)
      writeCuratedLibrarySyncDeferredOps(remainingDeferred)
      return { status: 'success' }
    }
    const pushed = await pushCuratedOps({ baseRevision: snapshot.revision, ops })
    if (!pushed.ok) {
      rememberPushConflicts(ops, pushed.snapshot)
      const conflictApplied = await applyRemoteSnapshot(
        pushed.snapshot,
        after,
        incrementalApplyOptions(),
        applyCtx(true)
      )
      writeCuratedLibrarySyncDeferredOps([...remainingDeferred, ...conflictApplied.deferred])
      persistAppliedSnapshot(pushed.snapshot)
      return { status: 'success' }
    }
    persistAppliedSnapshot(pushed.snapshot)
    writeCuratedLibrarySyncDeferredOps(remainingDeferred)
    return { status: 'success' }
  } finally {
    release()
    await notifyTree()
  }
}

const mapCuratedError = (message: string): string => {
  const upper = message.toUpperCase()
  if (upper.includes('DISK_FULL') || upper.includes('ENOSPC')) {
    return 'cloudSync.curatedLibrary.errors.diskFull'
  }
  if (upper.includes('QUOTA') || upper.includes('LIMIT')) {
    return 'cloudSync.curatedLibrary.errors.quotaExceeded'
  }
  if (upper.includes('HASH')) return 'cloudSync.curatedLibrary.errors.hashMismatch'
  if (upper.includes('CANNOTCONNECT') || upper.includes('FETCH')) {
    return 'cloudSync.errors.cannotConnect'
  }
  if (upper.includes('PROTOCOL')) return 'cloudSync.curatedLibrary.errors.protocolUnsupported'
  if (upper.includes('FIRST_SNAPSHOT_WAIT')) {
    return 'cloudSync.curatedLibrary.errors.firstSnapshotWait'
  }
  return 'cloudSync.curatedLibrary.errors.failed'
}

const isFirstSnapshotRace = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.includes('FIRST_SNAPSHOT_LOCKED') || message.includes('FIRST_SNAPSHOT_EXISTS')
}

const runFirstSnapshotUpload = async (): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  sendProgress('cloudSync.curatedLibrary.progressScanning', 0, 1, { noProgress: true })
  const local = await scanCuratedLibraryForSync()
  const failedSha = await uploadMissingBlobs(local.files)
  const session = await beginFirstCuratedSnapshot()
  const entities = buildCloudEntitiesFromLocal({
    ...local,
    files: local.files.filter((file) => !failedSha.has(file.contentSha256))
  })
  const committed = await commitFirstCuratedSnapshot({
    sessionId: session.sessionId,
    ...entities
  })
  persistAppliedSnapshot(committed)
  writeCuratedLibrarySyncDeferredOps([])
  return { status: 'success' }
}

export const isCuratedLibrarySyncRunning = (): boolean => running

export const cancelCuratedLibrarySync = async (): Promise<{ ok: true }> => {
  cancelRequested = true
  abortController?.abort()
  return { ok: true }
}

export const runCuratedLibrarySync = async (
  payload: CuratedLibrarySyncStartPayload = {}
): Promise<CuratedLibrarySyncStartResult> => {
  const trigger: CuratedLibrarySyncTrigger =
    payload.trigger === 'scheduled'
      ? 'scheduled'
      : payload.trigger === 'realtime'
        ? 'realtime'
        : 'manual'
  if (running) return { status: 'already_running' }
  if (!isCuratedLibrarySyncEnabled()) return { status: 'not_enabled' }
  if (
    !resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)
  ) {
    return { status: 'not_configured' }
  }
  if (isLibraryMergeActive() || isLibraryRelocateActive() || hasLibraryRelocateJournalSync()) {
    return { status: 'busy_library' }
  }
  bindPowerMonitor()
  running = true
  cancelRequested = false
  abortController = new AbortController()
  sessionFailures = []
  sessionConflicts = []
  sessionAttemptedTransfers = false
  sessionCompletedWork = false
  sendProgress('cloudSync.curatedLibrary.progressStarting', 0, 1, {
    noProgress: true,
    isInitial: true
  })
  try {
    throwIfCancelled()
    let status = await fetchCuratedLibraryStatus()
    cacheQuotaFromStatus(status)
    const lastRevision = getCuratedLibrarySyncLastAppliedRevision()
    if (trigger === 'realtime') {
      if (!status.snapshotReady || lastRevision === null) return { status: 'success' }
      return await runIncremental()
    }
    if (!status.snapshotReady && status.firstSnapshotLocked) {
      status = await waitForFirstSnapshotUnlock()
    }
    if (!status.snapshotReady) {
      try {
        return await runFirstSnapshotUpload()
      } catch (error) {
        if (!isFirstSnapshotRace(error)) throw error
        status = await waitForFirstSnapshotUnlock()
        if (!status.snapshotReady) {
          return await runFirstSnapshotUpload()
        }
      }
    }
    if (lastRevision === null) {
      if (!payload.joinMode) {
        const local = await scanCuratedLibraryForSync()
        return {
          status: 'needs_join_choice',
          localFileCount: local.files.length,
          cloudFileCount: status.fileCount,
          cloudRevision: status.revision
        }
      }
      if (payload.joinMode === 'local-wins' && !payload.confirmOverwriteCloud) {
        const localCount = (await scanCuratedLibraryForSync()).files.length
        if (localCount === 0 || localCount * 2 < status.fileCount) {
          return {
            status: 'needs_overwrite_cloud_confirm',
            localFileCount: localCount,
            cloudFileCount: status.fileCount,
            cloudRevision: status.revision
          }
        }
      }
      return await runJoin(payload.joinMode)
    }
    return await runIncremental()
  } catch (error) {
    if (cancelRequested || (error as { name?: string })?.name === 'AbortError') {
      return { status: 'cancelled' }
    }
    const code = String((error as { code?: unknown })?.code || '')
    if (code === 'ENOSPC') return { status: 'disk_full' }
    const message = error instanceof Error ? error.message : String(error || 'CURATED_SYNC_FAILED')
    if (
      message.includes('fetch failed') ||
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT'
    ) {
      return { status: 'paused_offline' }
    }
    log.error('[curated-library-sync] failed', error)
    return { status: 'failed', message: mapCuratedError(message) }
  } finally {
    const cancelled = cancelRequested
    running = false
    abortController = null
    dismissProgress()
    if (!cancelled) {
      persistSessionReports(!sessionCompletedWork)
      emitSyncNotice()
    }
  }
}
