import store from './store'
import { isLibrarySetupActive } from './librarySetupState'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../shared/cloudSyncAuto'
import { runCloudSync } from './cloudSync'
import { logCloudSyncRc } from './cloudSyncDiagnostics'

let intervalHandle: ReturnType<typeof setInterval> | null = null

type CloudSyncAutoSkipReason = 'disabled' | 'library_setup' | 'library_not_ready' | 'no_user_key'

function getCloudSyncAutoSkipReason(): CloudSyncAutoSkipReason | null {
  if (!normalizeCloudSyncAutoEnabled(store.settingConfig?.cloudSyncAutoEnabled)) return 'disabled'
  if (isLibrarySetupActive()) return 'library_setup'
  if (!store.databaseDir) return 'library_not_ready'
  if (!String(store.settingConfig?.cloudSyncUserKey || '').trim()) return 'no_user_key'
  return null
}

export function stopCloudSyncScheduler(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

async function runScheduledTick(): Promise<void> {
  const skipReason = getCloudSyncAutoSkipReason()
  if (skipReason) {
    logCloudSyncRc('scheduler.tick.skip', { reason: skipReason })
    return
  }
  await runCloudSync('scheduled')
}

export function restartCloudSyncScheduler(options?: { immediate?: boolean }): void {
  const hadTimer = intervalHandle !== null
  stopCloudSyncScheduler()
  const skipReason = getCloudSyncAutoSkipReason()
  const intervalMs = normalizeCloudSyncAutoIntervalMs(store.settingConfig?.cloudSyncAutoIntervalMs)
  const immediate = options?.immediate !== false
  logCloudSyncRc('scheduler.restart', {
    hadTimer,
    immediate,
    intervalMs,
    skipReason
  })
  if (skipReason) return
  if (immediate) {
    void runScheduledTick()
  }
  intervalHandle = setInterval(() => {
    void runScheduledTick()
  }, intervalMs)
}
