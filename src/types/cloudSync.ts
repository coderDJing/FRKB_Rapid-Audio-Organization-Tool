// 云同步相关共享类型
// 由 store / cloudSyncSyncDialog / cloudSyncSummaryDialog / App.vue 等复用

export type CloudSyncPhase =
  | 'checking'
  | 'diffing'
  | 'analyzing'
  | 'pulling'
  | 'committing'
  | 'finalizing'
  | 'idle'

export type CloudSyncState = 'syncing' | 'success' | 'failed' | 'cancelled'

export type CloudSyncProgressDetails = {
  clientCount?: number
  serverCount?: number
  toAddCount?: number
  pulledPages?: number
  totalPages?: number
}

export type CloudSyncProgressPayload = {
  phase: CloudSyncPhase
  percent: number
  details?: CloudSyncProgressDetails
}

export type CloudSyncSummary = {
  addedToServerCount?: number
  pulledToClientCount?: number
  curatedArtistClientInitialCount?: number
  curatedArtistClientCountAfter?: number
  curatedArtistServerInitialCount?: number
  curatedArtistServerCountAfter?: number
  durationMs?: number
  clientInitialCount?: number
  totalClientCountAfter?: number
  serverInitialCount?: number
  totalServerCountAfter?: number
}

export type CloudSyncNoticePayload = {
  code?: string
  message?: string
  retryAfterMs?: number
  currentInWindow?: number
  details?: {
    retryAfterMs?: number
  }
}

export type CloudSyncErrorPayload = {
  message?: string
  error?: {
    code?: string
    error?: string
    scope?: string
    retryAfterMs?: number
    details?: Record<string, unknown>
  }
}
