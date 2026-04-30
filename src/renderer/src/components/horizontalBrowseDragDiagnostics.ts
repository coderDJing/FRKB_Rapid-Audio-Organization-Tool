import type { HorizontalBrowseTransportDeckSnapshot } from '@shared/horizontalBrowseTransport'

const roundNumber = (value: unknown, digits = 3) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(numeric.toFixed(digits))
}

const normalizePayload = (value: unknown): unknown => {
  if (typeof value === 'number') return roundNumber(value)
  if (Array.isArray(value)) return value.map((item) => normalizePayload(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizePayload(item)
    ])
  )
}

export const buildHorizontalBrowseDeckDiagnostics = (
  snapshot?: HorizontalBrowseTransportDeckSnapshot | null
) => {
  if (!snapshot) return null
  return {
    loaded: snapshot.loaded,
    decoding: snapshot.decoding,
    playRequested: snapshot.playRequested,
    playingAudible: snapshot.playingAudible,
    playheadLoaded: snapshot.playheadLoaded,
    playing: snapshot.playing,
    currentSec: roundNumber(snapshot.currentSec),
    renderCurrentSec: roundNumber(snapshot.renderCurrentSec),
    durationSec: roundNumber(snapshot.durationSec),
    playbackRate: roundNumber(snapshot.playbackRate, 6),
    effectiveBpm: roundNumber(snapshot.effectiveBpm, 6),
    syncEnabled: snapshot.syncEnabled,
    syncLock: snapshot.syncLock,
    leader: snapshot.leader,
    loopActive: snapshot.loopActive,
    loopStartSec: roundNumber(snapshot.loopStartSec),
    loopEndSec: roundNumber(snapshot.loopEndSec)
  }
}

export const sendHorizontalBrowseDragSyncDiagnostics = (
  stage: string,
  payload: Record<string, unknown> = {}
) => {
  if (typeof window === 'undefined') return
  if (!window.electron?.ipcRenderer?.send) return
  window.electron.ipcRenderer.send('outputLog', {
    level: 'info',
    source: 'renderer',
    scope: 'horizontal-browse-drag-sync',
    message: JSON.stringify(
      normalizePayload({
        stage,
        atMs: typeof performance === 'undefined' ? 0 : performance.now(),
        ...payload
      })
    )
  })
}
