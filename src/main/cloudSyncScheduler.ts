import store from './store'
import { isLibrarySetupActive } from './librarySetupState'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../shared/cloudSyncAuto'
import { runCloudSync } from './cloudSync'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../shared/cloudSyncDevUserKey'

let intervalHandle: ReturnType<typeof setInterval> | null = null

function isCloudSyncAutoRunnable(): boolean {
  if (!normalizeCloudSyncAutoEnabled(store.settingConfig?.cloudSyncAutoEnabled)) return false
  if (isLibrarySetupActive()) return false
  if (!store.databaseDir) return false
  return (
    resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)
      .length > 0
  )
}

export function stopCloudSyncScheduler(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

async function runScheduledTick(): Promise<void> {
  if (!isCloudSyncAutoRunnable()) return
  await runCloudSync('scheduled')
  const { isCuratedLibrarySyncEnabled } = await import('./librarySettingsDb')
  if (!isCuratedLibrarySyncEnabled()) return
  const { enqueueCuratedLibrarySync } = await import('./curatedLibrarySync/ipc')
  await enqueueCuratedLibrarySync({ trigger: 'scheduled' })
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
