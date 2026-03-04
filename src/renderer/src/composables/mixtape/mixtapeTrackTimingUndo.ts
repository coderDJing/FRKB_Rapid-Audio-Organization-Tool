import type { Ref } from 'vue'
import type { MixtapeMuteSegment, MixtapeTrack } from '@renderer/composables/mixtape/types'

export type TrackTimingUndoSnapshot = {
  trackId: string
  startSec: number
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
  fallbackStartSec: number
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

export const restoreTrackTimingUndoSnapshot = (
  tracks: Ref<MixtapeTrack[]>,
  snapshot: TrackTimingUndoSnapshot
) => {
  const targetIndex = tracks.value.findIndex((track) => track.id === snapshot.trackId)
  if (targetIndex < 0) return false
  const currentTrack = tracks.value[targetIndex]
  if (!currentTrack) return false
  const nextTrack: MixtapeTrack = {
    ...currentTrack,
    startSec: snapshot.startSec,
    bpm: snapshot.bpm,
    originalBpm: snapshot.originalBpm,
    masterTempo: snapshot.masterTempo,
    volumeMuteSegments: snapshot.volumeMuteSegments.map((segment) => ({
      startSec: Number(segment.startSec),
      endSec: Number(segment.endSec)
    }))
  }
  const nextTracks = [...tracks.value]
  nextTracks.splice(targetIndex, 1, nextTrack)
  tracks.value = nextTracks
  if (window?.electron?.ipcRenderer?.invoke) {
    void window.electron.ipcRenderer
      .invoke('mixtape:update-track-start-sec', {
        entries: [
          {
            itemId: snapshot.trackId,
            startSec: Number(snapshot.startSec),
            bpm: snapshot.bpm,
            originalBpm: snapshot.originalBpm,
            masterTempo: snapshot.masterTempo
          }
        ]
      })
      .catch((error) => {
        console.error('[mixtape] undo track timing failed', {
          itemId: snapshot.trackId,
          error
        })
      })
    void window.electron.ipcRenderer
      .invoke('mixtape:update-volume-mute-segments', {
        entries: [
          {
            itemId: snapshot.trackId,
            segments: snapshot.volumeMuteSegments.map((segment) => ({
              startSec: Number(segment.startSec),
              endSec: Number(segment.endSec)
            }))
          }
        ]
      })
      .catch((error) => {
        console.error('[mixtape] undo volume mute segments failed', {
          itemId: snapshot.trackId,
          error
        })
      })
  }
  return true
}
