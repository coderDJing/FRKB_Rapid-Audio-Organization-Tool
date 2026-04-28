import type { Ref } from 'vue'
import { normalizeMixtapeLaneIndex } from '@renderer/composables/mixtape/constants'
import type { MixtapeMuteSegment, MixtapeTrack } from '@renderer/composables/mixtape/types'

export type TrackTimingUndoSnapshot = {
  trackId: string
  startSec: number
  laneIndex: number
  bpm?: number
  originalBpm?: number
  masterTempo: boolean
  volumeMuteSegments: MixtapeMuteSegment[]
}

const normalizeTrackTimingSnapshotNumber = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Number(numeric) : undefined
}

export const buildTrackTimingUndoSnapshot = (
  track: MixtapeTrack,
  fallbackStartSec: number,
  fallbackLaneIndex = 0
): TrackTimingUndoSnapshot => {
  const trackStartSec = normalizeTrackTimingSnapshotNumber(track.startSec)
  const safeFallbackStartSec = Math.max(
    0,
    normalizeTrackTimingSnapshotNumber(fallbackStartSec) || 0
  )
  const startSec =
    typeof trackStartSec === 'number' && trackStartSec >= 0 ? trackStartSec : safeFallbackStartSec
  const bpm = normalizeTrackTimingSnapshotNumber(track.bpm)
  const originalBpm = normalizeTrackTimingSnapshotNumber(track.originalBpm)
  const volumeMuteSegments = Array.isArray(track.volumeMuteSegments)
    ? track.volumeMuteSegments.map((segment) => ({
        startSec: Number(segment.startSec),
        endSec: Number(segment.endSec)
      }))
    : []
  return {
    trackId: track.id,
    startSec: Number(startSec.toFixed(4)),
    laneIndex: normalizeMixtapeLaneIndex(track.laneIndex, fallbackLaneIndex),
    bpm: typeof bpm === 'number' && bpm > 0 ? Number(bpm.toFixed(6)) : undefined,
    originalBpm:
      typeof originalBpm === 'number' && originalBpm > 0
        ? Number(originalBpm.toFixed(6))
        : undefined,
    masterTempo: track.masterTempo !== false,
    volumeMuteSegments
  }
}

export const isTrackTimingSnapshotSame = (
  left: TrackTimingUndoSnapshot | null,
  right: TrackTimingUndoSnapshot | null
) => JSON.stringify(left) === JSON.stringify(right)

export const restoreTrackTimingUndoSnapshots = (
  tracks: Ref<MixtapeTrack[]>,
  snapshots: TrackTimingUndoSnapshot[]
) => {
  if (!Array.isArray(snapshots) || !snapshots.length) return false
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.trackId, snapshot]))
  let restored = false
  const nextTracks = tracks.value.map((track) => {
    const snapshot = snapshotById.get(track.id)
    if (!snapshot) return track
    restored = true
    return {
      ...track,
      startSec: snapshot.startSec,
      laneIndex: snapshot.laneIndex,
      bpm: snapshot.bpm,
      originalBpm: snapshot.originalBpm,
      masterTempo: snapshot.masterTempo,
      volumeMuteSegments: snapshot.volumeMuteSegments.map((segment) => ({
        startSec: Number(segment.startSec),
        endSec: Number(segment.endSec)
      }))
    }
  })
  if (!restored) return false
  tracks.value = nextTracks
  if (window?.electron?.ipcRenderer?.invoke) {
    void window.electron.ipcRenderer
      .invoke('mixtape:update-track-start-sec', {
        entries: snapshots.map((snapshot) => ({
          itemId: snapshot.trackId,
          startSec: Number(snapshot.startSec),
          laneIndex: snapshot.laneIndex,
          bpm: snapshot.bpm,
          originalBpm: snapshot.originalBpm,
          masterTempo: snapshot.masterTempo
        }))
      })
      .catch((error) => {
        console.error('[mixtape] undo track timing failed', {
          count: snapshots.length,
          error
        })
      })
    void window.electron.ipcRenderer
      .invoke('mixtape:update-volume-mute-segments', {
        entries: snapshots.map((snapshot) => ({
          itemId: snapshot.trackId,
          segments: snapshot.volumeMuteSegments.map((segment) => ({
            startSec: Number(segment.startSec),
            endSec: Number(segment.endSec)
          }))
        }))
      })
      .catch((error) => {
        console.error('[mixtape] undo volume mute segments failed', {
          count: snapshots.length,
          error
        })
      })
  }
  return true
}

export const restoreTrackTimingUndoSnapshot = (
  tracks: Ref<MixtapeTrack[]>,
  snapshot: TrackTimingUndoSnapshot
) => restoreTrackTimingUndoSnapshots(tracks, [snapshot])
