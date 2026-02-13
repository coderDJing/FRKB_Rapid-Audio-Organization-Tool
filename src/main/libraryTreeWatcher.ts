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

const WATCH_DEBOUNCE_MS = 400

function clearDebounceTimer() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

async function reconcileLibraryTree(window: BrowserWindow | null) {
  if (reconciling) return
  const rootDir = store.databaseDir
  if (!rootDir) return
  reconciling = true
  try {
    await ensureEnglishCoreLibraries(rootDir)
    const result = await syncLibraryTreeFromDisk(rootDir, {
      coreDirNames: {
        FilterLibrary: getCoreFsDirName('FilterLibrary'),
        CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
        MixtapeLibrary: getCoreFsDirName('MixtapeLibrary'),
        RecycleBin: getCoreFsDirName('RecycleBin')
      },
      audioExtensions: store.settingConfig?.audioExt
    })
    if (result.added + result.removed + result.updated > 0) {
      await pruneOrphanedSongListCaches(rootDir)
      const tree = await getLibrary({ skipSync: true })
      window?.webContents.send('library-tree-updated', tree)
    }
  } catch (error) {
    log.warn('[watcher] library reconcile failed', error)
  } finally {
    reconciling = false
  }
}

function scheduleReconcile(window: BrowserWindow | null) {
  clearDebounceTimer()
  debounceTimer = setTimeout(() => {
    void reconcileLibraryTree(window)
  }, WATCH_DEBOUNCE_MS)
}

export function startLibraryTreeWatcher(window: BrowserWindow | null): void {
  if (watcher) return
  const rootDir = store.databaseDir
  if (!rootDir) return
  const libraryRoot = path.join(rootDir, 'library')
  if (!fs.pathExistsSync(libraryRoot)) return
  try {
    watcher = fs.watch(libraryRoot, { recursive: true }, () => {
      scheduleReconcile(window)
    })
    watcher.on('error', (error) => {
      log.warn('[watcher] library watcher error', error)
    })
  } catch (error) {
    log.warn('[watcher] library watcher start failed', error)
  }
}

export function stopLibraryTreeWatcher(): void {
  clearDebounceTimer()
  if (!watcher) return
  try {
    watcher.close()
  } catch {}
  watcher = null
}

export default {
  startLibraryTreeWatcher,
  stopLibraryTreeWatcher
}
