export const CLOUD_SYNC_AUTO_INTERVAL_MS = {
  minutes15: 15 * 60 * 1000,
  minutes30: 30 * 60 * 1000,
  hours1: 60 * 60 * 1000,
  hours6: 6 * 60 * 60 * 1000,
  hours12: 12 * 60 * 60 * 1000,
  hours24: 24 * 60 * 60 * 1000
} as const

export const CLOUD_SYNC_AUTO_INTERVAL_VALUES_MS = [
  CLOUD_SYNC_AUTO_INTERVAL_MS.minutes15,
  CLOUD_SYNC_AUTO_INTERVAL_MS.minutes30,
  CLOUD_SYNC_AUTO_INTERVAL_MS.hours1,
  CLOUD_SYNC_AUTO_INTERVAL_MS.hours6,
  CLOUD_SYNC_AUTO_INTERVAL_MS.hours12,
  CLOUD_SYNC_AUTO_INTERVAL_MS.hours24
] as const

export type CloudSyncAutoIntervalMs = (typeof CLOUD_SYNC_AUTO_INTERVAL_VALUES_MS)[number]

export const DEFAULT_CLOUD_SYNC_AUTO_ENABLED = false
export const DEFAULT_CLOUD_SYNC_AUTO_INTERVAL_MS = CLOUD_SYNC_AUTO_INTERVAL_MS.hours1

export function normalizeCloudSyncAutoIntervalMs(value: unknown): CloudSyncAutoIntervalMs {
  const numeric = Number(value)
  for (const allowed of CLOUD_SYNC_AUTO_INTERVAL_VALUES_MS) {
    if (numeric === allowed) return allowed
  }
  return DEFAULT_CLOUD_SYNC_AUTO_INTERVAL_MS
}

export function normalizeCloudSyncAutoEnabled(value: unknown): boolean {
  return value === true
}
