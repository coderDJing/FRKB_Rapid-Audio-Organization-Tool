export type PlaylistScanDiagnosticHandle = {
  update: (phase: string, details?: Record<string, unknown>) => void
  complete: (details?: Record<string, unknown>) => void
  fail: (details?: Record<string, unknown>) => void
}

type PlaylistScanDiagnosticEntry = {
  traceId: string
  phase: string
  startedAtMs: number
  phaseStartedAtMs: number
  completedAtMs?: number
  details: Record<string, unknown>
}

const RECENT_DIAGNOSTIC_TTL_MS = 30_000
const MAX_RECENT_DIAGNOSTICS = 8
const activeDiagnostics = new Map<string, PlaylistScanDiagnosticEntry>()
const recentDiagnostics: PlaylistScanDiagnosticEntry[] = []

const pruneRecentDiagnostics = (now: number) => {
  while (
    recentDiagnostics.length > 0 &&
    now - (recentDiagnostics[0]?.completedAtMs || now) > RECENT_DIAGNOSTIC_TTL_MS
  ) {
    recentDiagnostics.shift()
  }
  if (recentDiagnostics.length > MAX_RECENT_DIAGNOSTICS) {
    recentDiagnostics.splice(0, recentDiagnostics.length - MAX_RECENT_DIAGNOSTICS)
  }
}

export const beginPlaylistScanDiagnostic = (
  traceId: string,
  details: Record<string, unknown>
): PlaylistScanDiagnosticHandle => {
  const startedAtMs = Date.now()
  const entry: PlaylistScanDiagnosticEntry = {
    traceId,
    phase: 'worker-scan',
    startedAtMs,
    phaseStartedAtMs: startedAtMs,
    details: { ...details }
  }
  activeDiagnostics.set(traceId, entry)

  const update = (phase: string, nextDetails: Record<string, unknown> = {}) => {
    if (!activeDiagnostics.has(traceId)) return
    entry.phase = phase
    entry.phaseStartedAtMs = Date.now()
    Object.assign(entry.details, nextDetails)
  }

  const finish = (phase: string, nextDetails: Record<string, unknown> = {}) => {
    if (!activeDiagnostics.delete(traceId)) return
    const completedAtMs = Date.now()
    entry.phase = phase
    entry.phaseStartedAtMs = completedAtMs
    entry.completedAtMs = completedAtMs
    Object.assign(entry.details, nextDetails)
    recentDiagnostics.push(entry)
    pruneRecentDiagnostics(completedAtMs)
  }

  return {
    update,
    complete: (nextDetails) => finish('response-ready', nextDetails),
    fail: (nextDetails) => finish('failed', nextDetails)
  }
}

export const getPlaylistScanDiagnosticSnapshot = () => {
  const now = Date.now()
  pruneRecentDiagnostics(now)
  return [...activeDiagnostics.values(), ...recentDiagnostics].map((entry) => ({
    traceId: entry.traceId,
    phase: entry.phase,
    startedAtMs: entry.startedAtMs,
    completedAtMs: entry.completedAtMs,
    elapsedMs: Math.max(0, (entry.completedAtMs || now) - entry.startedAtMs),
    phaseElapsedMs: Math.max(0, now - entry.phaseStartedAtMs),
    ...entry.details
  }))
}
