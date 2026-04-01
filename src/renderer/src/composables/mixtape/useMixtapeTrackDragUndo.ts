import type { Ref } from 'vue'
import {
  buildTrackTimingUndoSnapshot,
  isTrackTimingSnapshotSame,
  restoreTrackTimingUndoSnapshot
} from '@renderer/composables/mixtape/mixtapeTrackTimingUndo'
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
    const currentTrack = tracks.value.find((track) => track.id === targetTrackId) || null
    const beforeSnapshot = currentTrack
      ? buildTrackTimingUndoSnapshot(currentTrack, fallbackStartSec)
      : null
    handleTrackDragStart(item, event)
    if (!beforeSnapshot) return
    window.addEventListener(
      'mouseup',
      () => {
        const latestTrack = tracks.value.find((track) => track.id === targetTrackId) || null
        if (!latestTrack) return
        const afterSnapshot = buildTrackTimingUndoSnapshot(latestTrack, fallbackStartSec)
        if (isTrackTimingSnapshotSame(beforeSnapshot, afterSnapshot)) return
        pushExternalUndoStep(() => restoreTrackTimingUndoSnapshot(tracks, beforeSnapshot))
      },
      { once: true }
    )
  }
}
