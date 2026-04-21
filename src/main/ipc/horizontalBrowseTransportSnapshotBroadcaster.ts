import mainWindow from '../window/mainWindow'
import {
  HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
  type HorizontalBrowseTransportSnapshot
} from '@shared/horizontalBrowseTransport'

const SNAPSHOT_BROADCAST_INTERVAL_MS = 250

let snapshotBroadcasterTimer: ReturnType<typeof setInterval> | null = null
let lastBroadcastWasActive = false

const hasActiveTransportState = (snapshot: HorizontalBrowseTransportSnapshot) =>
  [snapshot.top, snapshot.bottom].some(
    (deck) => deck.loaded || deck.decoding || deck.playing || deck.syncEnabled
  )

export const broadcastHorizontalBrowseTransportSnapshot = (
  snapshot: HorizontalBrowseTransportSnapshot
) => {
  const targetWindow = mainWindow.instance
  if (!targetWindow || targetWindow.isDestroyed()) return
  try {
    targetWindow.webContents.send(HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT, snapshot)
  } catch {}
}

export const startHorizontalBrowseTransportSnapshotBroadcaster = (
  getSnapshot: () => HorizontalBrowseTransportSnapshot
) => {
  if (snapshotBroadcasterTimer) return
  snapshotBroadcasterTimer = setInterval(() => {
    try {
      const snapshot = getSnapshot()
      const active = hasActiveTransportState(snapshot)
      if (!active && !lastBroadcastWasActive) return
      lastBroadcastWasActive = active
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
    } catch {}
  }, SNAPSHOT_BROADCAST_INTERVAL_MS)
}

export const stopHorizontalBrowseTransportSnapshotBroadcaster = () => {
  if (!snapshotBroadcasterTimer) return
  clearInterval(snapshotBroadcasterTimer)
  snapshotBroadcasterTimer = null
  lastBroadcastWasActive = false
}
