import store from './store'
import { isLibrarySetupActive } from './librarySetupState'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../shared/cloudSyncAuto'
import { runCloudSync } from './cloudSync'

let intervalHandle: ReturnType<typeof setInterval> | null = null

function isCloudSyncAutoRunnable(): boolean {
  if (!normalizeCloudSyncAutoEnabled(store.settingConfig?.cloudSyncAutoEnabled)) return false
  if (isLibrarySetupActive()) return false
  if (!store.databaseDir) return false
  return String(store.settingConfig?.cloudSyncUserKey || '').trim().length > 0
}

export function stopCloudSyncScheduler(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

async function runScheduledTick(): Promise<void> {
  if (!isCloudSyncAutoRunnable()) return
  await runCloudSync('scheduled')
}

export function restartCloudSyncScheduler(options?: { immediate?: boolean }): void {
  stopCloudSyncScheduler()
  if (!isCloudSyncAutoRunnable()) return
  const intervalMs = normalizeCloudSyncAutoIntervalMs(store.settingConfig?.cloudSyncAutoIntervalMs)
  if (options?.immediate !== false) {
    void runScheduledTick()
  }
  intervalHandle = setInterval(() => {
    void runScheduledTick()
  }, intervalMs)
}
