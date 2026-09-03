import fs = require('fs-extra')
import path = require('path')
import type { BrowserWindow } from 'electron'
import store from './store'
import { log } from './log'
import { ensureEnglishCoreLibraries, getCoreFsDirName, getLibrary } from './utils'
import { syncLibraryTreeFromDisk } from './libraryTreeDb'
import { pruneOrphanedSongListCaches } from './services/cacheMaintenance'

let watcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null
let reconciling = false
let bulkOperationDepth = 0
let pendingBulkReconcileWindow: BrowserWindow | null = null
let mutationListener: (() => void) | null = null
let pendingCuratedContentChange = false
let watchWindow: BrowserWindow | null = null

const WATCH_DEBOUNCE_MS = 400

export function bindLibraryTreeMutationListener(listener: (() => void) | null): void {
  mutationListener = listener
}

const watchPathEquals = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right

const isCuratedLibraryWatchPath = (filename: string | Buffer | null | undefined): boolean => {
  const raw = String(filename || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!raw) return true
  const first = raw.split('/')[0] || ''
  const curatedName = getCoreFsDirName('CuratedLibrary')
  const recycleName = getCoreFsDirName('RecycleBin')
  if (watchPathEquals(first, curatedName) || watchPathEquals(first, '精选库')) return true
  // 删除曲目是搬进回收站；Windows 上 rename 常常只报 RecycleBin 路径
  if (watchPathEquals(first, recycleName) || watchPathEquals(first, '回收站')) return true
  return !raw.includes('/')
}

/**
 * True only while a real tree write is in flight (reconcile) or a bulk
 * maintenance section has paused scheduling. Pending debounce alone is not busy —
 * callers that need a quiet tree should discard the timer instead of blocking.
 */
export function isLibraryTreeWatcherBusy(): boolean {
  return reconciling || bulkOperationDepth > 0
}

function clearDebounceTimer() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/** Drop a scheduled reconcile that has not started yet (debounce window only). */
export function discardPendingLibraryTreeReconcile(): void {
  clearDebounceTimer()
}

/**
 * Wait until reconcile / bulk depth drain. Does not treat debounce as busy;
 * call discardPendingLibraryTreeReconcile first when preparing a mutation lock.
 */
export async function waitForLibraryTreeWatcherIdle(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (isLibraryTreeWatcherBusy()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

async function reconcileLibraryTree(window: BrowserWindow | null, fromBulk = false) {
  if (reconciling) return
  const rootDir = store.databaseDir
  if (!rootDir) return
  reconciling = true
  const curatedContentChanged = pendingCuratedContentChange
  pendingCuratedContentChange = false
  try {
    await ensureEnglishCoreLibraries(rootDir)
    const result = await syncLibraryTreeFromDisk(rootDir, {
      coreDirNames: {
        FilterLibrary: getCoreFsDirName('FilterLibrary'),
        CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
        SetLibrary: getCoreFsDirName('SetLibrary'),
        MixtapeLibrary: getCoreFsDirName('MixtapeLibrary'),
        RecordingLibrary: getCoreFsDirName('RecordingLibrary'),
        RecycleBin: getCoreFsDirName('RecycleBin')
      },
      audioExtensions: store.settingConfig?.audioExt
    })
    const treeChanged = result.added + result.removed + result.updated > 0
    if (treeChanged) {
      await pruneOrphanedSongListCaches(rootDir)
      const tree = await getLibrary({ skipSync: true })
      window?.webContents.send('library-tree-updated', tree)
    }
    if (!fromBulk && (treeChanged || curatedContentChanged)) {
      mutationListener?.()
    }
  } catch (error) {
    log.error('[watcher] library reconcile failed', error)
  } finally {
    reconciling = false
  }
}

function scheduleReconcile(window: BrowserWindow | null, fromBulk = false) {
  clearDebounceTimer()
  if (bulkOperationDepth > 0) {
    pendingBulkReconcileWindow = window
    return
  }
  debounceTimer = setTimeout(() => {
    void reconcileLibraryTree(window, fromBulk)
  }, WATCH_DEBOUNCE_MS)
}

export function beginLibraryTreeWatcherBulkOperation(): () => void {
  bulkOperationDepth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    bulkOperationDepth = Math.max(0, bulkOperationDepth - 1)
    if (bulkOperationDepth > 0 || !pendingBulkReconcileWindow) return
    const window = pendingBulkReconcileWindow
    pendingBulkReconcileWindow = null
    scheduleReconcile(window, true)
  }
}

/** 精选库内容变了（含删除后文件落在回收站）。不是把回收站同步上云。 */
export function notifyLibraryFsChanged(_absPath?: string): void {
  pendingCuratedContentChange = true
  scheduleReconcile(watchWindow)
}

export function startLibraryTreeWatcher(window: BrowserWindow | null): void {
  watchWindow = window
  if (watcher) return
  const rootDir = store.databaseDir
  if (!rootDir) return
  const libraryRoot = path.join(rootDir, 'library')
  if (!fs.pathExistsSync(libraryRoot)) return
  try {
    watcher = fs.watch(libraryRoot, { recursive: true }, (_event, filename) => {
      if (isCuratedLibraryWatchPath(filename)) pendingCuratedContentChange = true
      scheduleReconcile(window)
    })
    watcher.on('error', (error) => {
      log.error('[watcher] library watcher error', error)
    })
  } catch (error) {
    log.error('[watcher] library watcher start failed', error)
  }
}

export function stopLibraryTreeWatcher(): void {
  clearDebounceTimer()
  pendingCuratedContentChange = false
  watchWindow = null
  if (!watcher) return
  try {
    watcher.close()
  } catch {}
  watcher = null
}
