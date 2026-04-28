import type { Ref } from 'vue'
import {
  buildTrackTimingUndoSnapshot,
  isTrackTimingSnapshotSame,
  restoreTrackTimingUndoSnapshots
} from '@renderer/composables/mixtape/mixtapeTrackTimingUndo'
import { LANE_COUNT } from '@renderer/composables/mixtape/constants'
import type { MixtapeTrack, TimelineTrackLayout } from '@renderer/composables/mixtape/types'

type UseMixtapeTrackDragUndoOptions = {
  tracks: Ref<MixtapeTrack[]>
  handleTrackDragStart: (item: TimelineTrackLayout, event: MouseEvent) => void
  pushExternalUndoStep: (undo: (() => boolean) | null | undefined) => void
}

export const useMixtapeTrackDragUndo = ({
  tracks,
  handleTrackDragStart,
  pushExternalUndoStep
}: UseMixtapeTrackDragUndoOptions) => {
  return (item: TimelineTrackLayout, event: MouseEvent) => {
    const targetTrackId = item?.track?.id || ''
    const fallbackStartSec = Number(item?.startSec) || 0
    const fallbackLaneIndex = Number(item?.laneIndex) || 0
    const currentTrack = tracks.value.find((track) => track.id === targetTrackId) || null
    const beforeSnapshot = currentTrack
      ? buildTrackTimingUndoSnapshot(currentTrack, fallbackStartSec, fallbackLaneIndex)
      : null
    const beforeSnapshots = tracks.value.map((track, index) =>
      track.id === targetTrackId && beforeSnapshot
        ? beforeSnapshot
        : buildTrackTimingUndoSnapshot(
            track,
            Number(track.startSec) || 0,
            Number.isFinite(Number(track.laneIndex)) ? Number(track.laneIndex) : index % LANE_COUNT
          )
    )
    handleTrackDragStart(item, event)
    if (!beforeSnapshot) return
    window.addEventListener(
      'mouseup',
      () => {
        const latestTrack = tracks.value.find((track) => track.id === targetTrackId) || null
        if (!latestTrack) return
        const afterSnapshot = buildTrackTimingUndoSnapshot(
          latestTrack,
          fallbackStartSec,
          fallbackLaneIndex
        )
        const afterSnapshotById = new Map(
          tracks.value.map((track, index) => [
            track.id,
            track.id === targetTrackId
              ? afterSnapshot
              : buildTrackTimingUndoSnapshot(
                  track,
                  Number(track.startSec) || 0,
                  Number.isFinite(Number(track.laneIndex))
                    ? Number(track.laneIndex)
                    : index % LANE_COUNT
                )
          ])
        )
        const changedSnapshots = beforeSnapshots.filter((snapshot) => {
          const nextSnapshot = afterSnapshotById.get(snapshot.trackId) || null
          return !isTrackTimingSnapshotSame(snapshot, nextSnapshot)
        })
        if (!changedSnapshots.length) return
        pushExternalUndoStep(() => restoreTrackTimingUndoSnapshots(tracks, changedSnapshots))
      },
      { once: true }
    )
  }
}
