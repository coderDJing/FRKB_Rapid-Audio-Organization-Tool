import { computed, watch, type Ref } from 'vue'
import {
  normalizeMixtapeGlobalBpmEnvelopePoints,
  resolveDefaultGlobalBpmFromTracks
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import {
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoPlaylistId
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import type { MixtapeTrack } from '@renderer/composables/mixtape/types'

type ReadonlyRef<T> = Readonly<Ref<T>>

type UseMixtapeMasterTempoLaneOptions = {
  masterTempoLaneExpanded: Ref<boolean>
  tracks: Ref<MixtapeTrack[]>
  timelineVisualScale: ReadonlyRef<number>
  timelineTrackAreaHeight: ReadonlyRef<number>
  mixtapePlaylistId: ReadonlyRef<string>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
}

const MASTER_TEMPO_LANE_BASE_HEIGHT = 84
const MASTER_TEMPO_LANE_MIN_HEIGHT = 68
const MASTER_TEMPO_LANE_COLLAPSED_HEIGHT = 24
const MASTER_TEMPO_LANE_DIVIDER_HEIGHT = 24

export const useMixtapeMasterTempoLane = ({
  masterTempoLaneExpanded,
  tracks,
  timelineVisualScale,
  timelineTrackAreaHeight,
  mixtapePlaylistId,
  resolveTrackDurationSeconds
}: UseMixtapeMasterTempoLaneOptions) => {
  const masterTempoLaneHeight = computed(() => {
    if (!tracks.value.length) return 0
    if (!masterTempoLaneExpanded.value) return MASTER_TEMPO_LANE_COLLAPSED_HEIGHT
    const scale = Math.min(1, Math.max(0.5, Number(timelineVisualScale.value) || 1))
    return Math.max(MASTER_TEMPO_LANE_MIN_HEIGHT, Math.round(MASTER_TEMPO_LANE_BASE_HEIGHT * scale))
  })

  const masterTempoTimelineDurationSec = computed(() =>
    Math.max(
      0,
      ...tracks.value.map((track) => {
        const startSec = Number(track.startSec)
        const durationSec = Math.max(0, Number(resolveTrackDurationSeconds(track)) || 0)
        const safeStartSec = Number.isFinite(startSec) && startSec >= 0 ? startSec : 0
        return safeStartSec + durationSec
      })
    )
  )

  const masterTempoDefaultBpm = computed(() => resolveDefaultGlobalBpmFromTracks(tracks.value))

  const masterTempoEffectivePoints = computed(() =>
    normalizeMixtapeGlobalBpmEnvelopePoints(
      mixtapeGlobalTempoPlaylistId.value === mixtapePlaylistId.value
        ? mixtapeGlobalTempoEnvelope.value
        : [],
      masterTempoTimelineDurationSec.value,
      masterTempoDefaultBpm.value
    )
  )

  const masterTempoEdited = computed(() => {
    const points = masterTempoEffectivePoints.value
    if (points.length < 2) return false
    const baseBpm = masterTempoDefaultBpm.value
    return points.some((point) => Math.abs(Number(point.bpm) - baseBpm) > 0.01)
  })

  const timelineTrackAreaStyle = computed(() => ({
    height: `${
      timelineTrackAreaHeight.value +
      masterTempoLaneHeight.value +
      (tracks.value.length ? MASTER_TEMPO_LANE_DIVIDER_HEIGHT : 0)
    }px`
  }))

  const handleToggleMasterTempoLane = () => {
    if (!tracks.value.length) return
    masterTempoLaneExpanded.value = !masterTempoLaneExpanded.value
  }

  watch(
    () => [mixtapePlaylistId.value, tracks.value.length] as const,
    ([playlistId, trackCount], previousValue) => {
      const [previousPlaylistId, previousTrackCount] = previousValue ?? ['', 0]
      if (trackCount === 0) {
        masterTempoLaneExpanded.value = false
        return
      }
      if (playlistId !== previousPlaylistId || (!previousTrackCount && trackCount > 0)) {
        masterTempoLaneExpanded.value = false
      }
    },
    { immediate: true }
  )

  return {
    handleToggleMasterTempoLane,
    masterTempoEdited,
    masterTempoLaneHeight,
    timelineTrackAreaStyle
  }
}
