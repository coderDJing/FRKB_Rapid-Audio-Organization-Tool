import store from './store'
import { isLibrarySetupActive } from './librarySetupState'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../shared/cloudSyncAuto'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../shared/cloudSyncDevUserKey'
import { isCuratedLibrarySyncEnabled } from './librarySettingsDb'
import { enqueueCuratedLibrarySync } from './curatedLibrarySync/queue'
import {
  hasPendingCuratedLibraryJoinPrompt,
  offerCuratedLibraryJoinPrompt
} from './curatedLibrarySync/joinPrompt'
import type { CloudSyncTrigger } from '../types/cloudSync'
import { bindLibraryTreeMutationListener } from './libraryTreeWatcher'

let intervalHandle: ReturnType<typeof setInterval> | null = null
let treeSyncTimer: ReturnType<typeof setTimeout> | null = null
let treeListenerBound = false
let runFingerprintSync: ((trigger: CloudSyncTrigger) => Promise<string>) | null = null

const TREE_SYNC_DEBOUNCE_MS = 2000

export function bindCloudSyncScheduler(run: (trigger: CloudSyncTrigger) => Promise<string>): void {
  runFingerprintSync = run
}

const hasCloudUserKey = (): boolean =>
  resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)
    .length > 0

function isCloudSyncAutoRunnable(): boolean {
  if (!normalizeCloudSyncAutoEnabled(store.settingConfig?.cloudSyncAutoEnabled)) return false
  if (isLibrarySetupActive()) return false
  if (!store.databaseDir) return false
  return hasCloudUserKey()
}

function canRunCuratedLibrarySyncNow(): boolean {
  if (isLibrarySetupActive()) return false
  if (!store.databaseDir) return false
  if (!isCuratedLibrarySyncEnabled()) return false
  return hasCloudUserKey()
}

export function stopCloudSyncScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  if (treeSyncTimer) {
    clearTimeout(treeSyncTimer)
    treeSyncTimer = null
  }
}

export async function runCuratedLibrarySyncTick(): Promise<void> {
  if (!canRunCuratedLibrarySyncNow()) return
  if (hasPendingCuratedLibraryJoinPrompt()) return
  const result = await enqueueCuratedLibrarySync({ trigger: 'scheduled' })
  offerCuratedLibraryJoinPrompt(result)
}

function scheduleCuratedLibrarySyncAfterTreeChange(): void {
  if (!canRunCuratedLibrarySyncNow()) return
  if (treeSyncTimer) clearTimeout(treeSyncTimer)
  treeSyncTimer = setTimeout(() => {
    treeSyncTimer = null
    void runCuratedLibrarySyncTick()
  }, TREE_SYNC_DEBOUNCE_MS)
}

export function scheduleCuratedLibrarySyncAfterLocalChange(): void {
  scheduleCuratedLibrarySyncAfterTreeChange()
}

function ensureLibraryTreeSyncTrigger(): void {
  if (treeListenerBound) return
  treeListenerBound = true
  bindLibraryTreeMutationListener(() => {
    scheduleCuratedLibrarySyncAfterTreeChange()
  })
}

async function runScheduledTick(): Promise<void> {
  if (isCloudSyncAutoRunnable() && runFingerprintSync) {
    await runFingerprintSync('scheduled')
  }
  await runCuratedLibrarySyncTick()
}

export function restartCloudSyncScheduler(options?: { immediate?: boolean }): void {
  stopCloudSyncScheduler()
  ensureLibraryTreeSyncTrigger()
  const autoRunnable = isCloudSyncAutoRunnable()
  const curatedRunnable = canRunCuratedLibrarySyncNow()
  if (!autoRunnable && !curatedRunnable) return
  if (options?.immediate !== false) {
    void runScheduledTick()
  }
  if (!autoRunnable) return
  const intervalMs = normalizeCloudSyncAutoIntervalMs(store.settingConfig?.cloudSyncAutoIntervalMs)
  intervalHandle = setInterval(() => {
    void runScheduledTick()
  }, intervalMs)
}
