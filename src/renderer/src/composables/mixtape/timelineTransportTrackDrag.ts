import { ref } from 'vue'
import {
  GRID_BEAT4_LINE_ZOOM,
  GRID_BEAT_LINE_ZOOM,
  LANE_COUNT
} from '@renderer/composables/mixtape/constants'
import {
  resolveBeatSecByBpm,
  resolveGridAnchorSec
} from '@renderer/composables/mixtape/mixxxSyncModel'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type { MixtapeTrack, TimelineTrackLayout } from '@renderer/composables/mixtape/types'

export const createTimelineTransportTrackDragModule = (ctx: any) => {
  const {
    tracks,
    normalizedRenderZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackStartSecById,
    resolveTimelineSecByX,
    stopTransportForTrackChange,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    persistTrackStartSec,
    persistTrackVolumeMuteSegments,
    remapVolumeMuteSegmentsForBpm,
    normalizeStartSec,
    clampNumber,
    normalizeBeatOffset
  } = ctx

  const isTrackDragging = ref(false)

  let trackDragState: {
    trackId: string
    startClientX: number
    initialStartSec: number
    previousTrackId: string
    snapshotTracks: MixtapeTrack[]
  } | null = null

  const resolvePreviousTrackId = (trackId: string) => {
    const ordered = [...tracks.value].sort(
      (a: MixtapeTrack, b: MixtapeTrack) => a.mixOrder - b.mixOrder
    )
    const index = ordered.findIndex((item: MixtapeTrack) => item.id === trackId)
    if (index <= 0) return ''
    return ordered[index - 1]?.id || ''
  }

  const findTrack = (trackId: string) =>
    tracks.value.find((item: MixtapeTrack) => item.id === trackId) || null

  const buildTrackTimingSnapshot = (inputTracks: MixtapeTrack[]) => {
    let cursorSec = 0
    return inputTracks.map((track, index) => {
      const laneIndex = index % LANE_COUNT
      const duration = resolveTrackDurationSeconds(track)
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
      const rawStartSec = Number(track.startSec)
      const startSec =
        Number.isFinite(rawStartSec) && rawStartSec >= 0 ? Math.max(0, rawStartSec) : cursorSec
      const endSec = startSec + safeDuration
      cursorSec = Math.max(cursorSec, endSec)
      return {
        id: track.id,
        laneIndex,
        startSec,
        endSec,
        durationSec: safeDuration
      }
    })
  }

  const resolveTrackDragBounds = (snapshotTracks: MixtapeTrack[], trackId: string) => {
    const timings = buildTrackTimingSnapshot(snapshotTracks)
    const target = timings.find((item) => item.id === trackId)
    if (!target) {
      return {
        minStart: 0,
        maxStart: Number.POSITIVE_INFINITY
      }
    }
    const sameLane = timings.filter((item) => item.laneIndex === target.laneIndex)
    const lanePos = sameLane.findIndex((item) => item.id === trackId)
    if (lanePos < 0) {
      return {
        minStart: 0,
        maxStart: Number.POSITIVE_INFINITY
      }
    }
    const prev = lanePos > 0 ? sameLane[lanePos - 1] : null
    const next = lanePos < sameLane.length - 1 ? sameLane[lanePos + 1] : null

    const minStart = prev ? prev.endSec : 0
    let maxStart = Number.POSITIVE_INFINITY
    if (next) {
      maxStart = Math.max(minStart, next.startSec - target.durationSec)
    }
    return {
      minStart,
      maxStart
    }
  }

  const resolveVisibleGridSnapStepBeats = () => {
    const zoomValue = Number(normalizedRenderZoom.value) || 0
    if (zoomValue >= GRID_BEAT_LINE_ZOOM) return 1
    if (zoomValue >= GRID_BEAT4_LINE_ZOOM) return 4
    return 32
  }

  const resolveSnappedStartSec = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapAnchorSec: number
    currentAnchorRawSec: number
    stepSec: number
  }) => {
    const stepSec = Number(payload.stepSec)
    if (!Number.isFinite(stepSec) || stepSec <= 0) return null
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    const snapAnchorSec = Number(payload.snapAnchorSec)
    const currentAnchorRawSec = Number(payload.currentAnchorRawSec)
    if (!Number.isFinite(snapAnchorSec) || !Number.isFinite(currentAnchorRawSec)) return null

    const startOffsetSec = rawStartSec - currentAnchorRawSec
    const rawIndex = (currentAnchorRawSec - snapAnchorSec) / stepSec
    if (!Number.isFinite(rawIndex)) return null

    let nearestIndex = Math.round(rawIndex)
    const minIndex = Math.ceil((minStartSec - startOffsetSec - snapAnchorSec) / stepSec)
    const maxIndex = Number.isFinite(maxStartSec)
      ? Math.floor((maxStartSec - startOffsetSec - snapAnchorSec) / stepSec)
      : Number.POSITIVE_INFINITY
    if (minIndex > maxIndex) return null
    nearestIndex = Math.max(minIndex, Math.min(maxIndex, nearestIndex))

    const snappedStartSec = startOffsetSec + snapAnchorSec + nearestIndex * stepSec
    if (!Number.isFinite(snappedStartSec)) return null
    return clampNumber(snappedStartSec, minStartSec, maxStartSec)
  }

  const handleTrackDragMove = (event: MouseEvent) => {
    if (!trackDragState) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const deltaSec = (event.clientX - trackDragState.startClientX) / pxPerSec
    const rawStartSec = Math.max(0, trackDragState.initialStartSec + deltaSec)
    const dragBounds = resolveTrackDragBounds(trackDragState.snapshotTracks, trackDragState.trackId)
    const clampedRawStartSec = clampNumber(rawStartSec, dragBounds.minStart, dragBounds.maxStart)
    let nextStartSec = clampedRawStartSec
    let nextBpm: number | undefined
    const currentTrackForSnap = findTrack(trackDragState.trackId)
    const snapStepBeats = resolveVisibleGridSnapStepBeats()
    const previousTrack = findTrack(trackDragState.previousTrackId)
    if (previousTrack) {
      const previousBpm = Number(previousTrack.bpm)
      if (Number.isFinite(previousBpm) && previousBpm > 0) {
        const previousStartSec = resolveTrackStartSecById(previousTrack.id)
        const previousFirstBeatSec = resolveTrackFirstBeatSeconds(previousTrack, previousBpm)
        const currentFirstBeatSecAtTarget = currentTrackForSnap
          ? resolveTrackFirstBeatSeconds(currentTrackForSnap, previousBpm)
          : 0
        const beatSec = resolveBeatSecByBpm(previousBpm)
        const snapStepSec = beatSec * snapStepBeats
        if (Number.isFinite(snapStepSec) && snapStepSec > 0) {
          const snapAnchor = resolveGridAnchorSec({
            startSec: previousStartSec,
            firstBeatSec: previousFirstBeatSec,
            beatSec,
            barBeatOffset: normalizeBeatOffset(previousTrack.barBeatOffset, 32)
          })
          const currentAnchorRawSec = resolveGridAnchorSec({
            startSec: clampedRawStartSec,
            firstBeatSec: currentFirstBeatSecAtTarget,
            beatSec,
            barBeatOffset: normalizeBeatOffset(currentTrackForSnap?.barBeatOffset, 32)
          })
          const snappedStartSec = resolveSnappedStartSec({
            rawStartSec: clampedRawStartSec,
            minStartSec: dragBounds.minStart,
            maxStartSec: dragBounds.maxStart,
            snapAnchorSec: snapAnchor,
            currentAnchorRawSec,
            stepSec: snapStepSec
          })
          if (typeof snappedStartSec === 'number') {
            nextStartSec = snappedStartSec
            nextBpm = previousBpm
          }
        }
      }
    }
    if (typeof nextBpm !== 'number' && currentTrackForSnap) {
      const currentBpm = Number(currentTrackForSnap.bpm)
      if (Number.isFinite(currentBpm) && currentBpm > 0) {
        const beatSec = resolveBeatSecByBpm(currentBpm)
        const snapStepSec = beatSec * snapStepBeats
        const currentFirstBeatSec = resolveTrackFirstBeatSeconds(currentTrackForSnap, currentBpm)
        const currentAnchorRawSec = resolveGridAnchorSec({
          startSec: clampedRawStartSec,
          firstBeatSec: currentFirstBeatSec,
          beatSec,
          barBeatOffset: normalizeBeatOffset(currentTrackForSnap.barBeatOffset, 32)
        })
        const snappedStartSec = resolveSnappedStartSec({
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          snapAnchorSec: 0,
          currentAnchorRawSec,
          stepSec: snapStepSec
        })
        if (typeof snappedStartSec === 'number') {
          nextStartSec = snappedStartSec
        }
      }
    }
    nextStartSec = clampNumber(nextStartSec, dragBounds.minStart, dragBounds.maxStart)

    const targetIndex = tracks.value.findIndex(
      (item: MixtapeTrack) => item.id === trackDragState?.trackId
    )
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const snapshotTrack =
      trackDragState.snapshotTracks.find((item: MixtapeTrack) => item.id === currentTrack.id) ||
      currentTrack
    const currentStartSec = resolveTrackStartSecById(currentTrack.id)
    const shouldUpdateStart = Math.abs(nextStartSec - currentStartSec) > 0.0001
    const shouldUpdateBpm =
      typeof nextBpm === 'number' &&
      Number.isFinite(nextBpm) &&
      nextBpm > 0 &&
      Math.abs((Number(currentTrack.bpm) || 0) - nextBpm) > 0.0001
    if (!shouldUpdateStart && !shouldUpdateBpm) return
    const nextTrack: MixtapeTrack = {
      ...currentTrack,
      startSec: nextStartSec
    }
    if (shouldUpdateBpm) {
      const safeNextBpm = Number(nextBpm)
      nextTrack.bpm = safeNextBpm
      nextTrack.masterTempo = true
      nextTrack.originalBpm =
        Number.isFinite(Number(currentTrack.originalBpm)) && Number(currentTrack.originalBpm) > 0
          ? currentTrack.originalBpm
          : Number(currentTrack.bpm) || safeNextBpm
      nextTrack.volumeMuteSegments = remapVolumeMuteSegmentsForBpm(snapshotTrack, safeNextBpm)
    }
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, nextTrack)
    tracks.value = nextTracks
    event.preventDefault()
  }

  const handleTrackDragEnd = () => {
    if (!trackDragState) return
    const targetTrackId = trackDragState.trackId
    const previousTrack =
      trackDragState.snapshotTracks.find((item: MixtapeTrack) => item.id === targetTrackId) || null
    const currentTrack = findTrack(targetTrackId)
    const previousStartSec = normalizeStartSec(previousTrack?.startSec)
    const currentStartSec = normalizeStartSec(currentTrack?.startSec)
    const normalizeTrackBpm = (value: unknown) => {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) return null
      return Number(numeric.toFixed(6))
    }
    const previousBpm = normalizeTrackBpm(previousTrack?.bpm)
    const currentBpm = normalizeTrackBpm(currentTrack?.bpm)
    const previousOriginalBpm = normalizeTrackBpm(previousTrack?.originalBpm)
    const currentOriginalBpm = normalizeTrackBpm(currentTrack?.originalBpm)
    const previousMasterTempo = previousTrack?.masterTempo !== false
    const currentMasterTempo = currentTrack?.masterTempo !== false
    isTrackDragging.value = false
    trackDragState = null
    window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
    window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!currentTrack) return
    const startChanged =
      currentStartSec !== null &&
      (previousStartSec === null || Math.abs(previousStartSec - currentStartSec) > 0.0001)
    const bpmChanged =
      currentBpm !== null && (previousBpm === null || Math.abs(previousBpm - currentBpm) > 0.0001)
    const originalBpmChanged =
      currentOriginalBpm !== null &&
      (previousOriginalBpm === null || Math.abs(previousOriginalBpm - currentOriginalBpm) > 0.0001)
    const masterTempoChanged = previousMasterTempo !== currentMasterTempo
    if (!startChanged && !bpmChanged && !originalBpmChanged && !masterTempoChanged) return
    void persistTrackStartSec([
      {
        itemId: targetTrackId,
        ...(startChanged ? { startSec: Number(currentStartSec) } : {}),
        ...(bpmChanged ? { bpm: Number(currentBpm) } : {}),
        ...(originalBpmChanged ? { originalBpm: Number(currentOriginalBpm) } : {}),
        ...(masterTempoChanged ? { masterTempo: currentMasterTempo } : {})
      }
    ])
    if (bpmChanged) {
      const currentDuration = resolveTrackDurationSeconds(currentTrack)
      const previousDuration = previousTrack ? resolveTrackDurationSeconds(previousTrack) : 0
      const currentSegments = normalizeVolumeMuteSegments(
        currentTrack.volumeMuteSegments,
        currentDuration
      )
      const previousSegments = normalizeVolumeMuteSegments(
        previousTrack?.volumeMuteSegments,
        previousDuration
      )
      if (
        JSON.stringify(currentSegments) !== JSON.stringify(previousSegments) ||
        currentSegments.length > 0 ||
        previousSegments.length > 0
      ) {
        void persistTrackVolumeMuteSegments([
          {
            itemId: targetTrackId,
            segments: currentSegments
          }
        ])
      }
    }
  }

  const handleTrackDragStart = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stopTransportForTrackChange()
    const trackId = item?.track?.id || ''
    if (!trackId) return
    const track = findTrack(trackId)
    if (!track) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    trackDragState = {
      trackId,
      startClientX: event.clientX,
      initialStartSec:
        Number.isFinite(Number(item.startSec)) && Number(item.startSec) >= 0
          ? Number(item.startSec)
          : resolveTimelineSecByX(item.startX, pxPerSec),
      previousTrackId: resolvePreviousTrackId(trackId),
      snapshotTracks: tracks.value.map((trackItem: MixtapeTrack) => ({ ...trackItem }))
    }
    isTrackDragging.value = true
    window.addEventListener('mousemove', handleTrackDragMove, { passive: false })
    window.addEventListener('mouseup', handleTrackDragEnd, { passive: true })
  }

  const cleanupTrackDrag = () => {
    isTrackDragging.value = false
    trackDragState = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
      window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    }
  }

  return {
    isTrackDragging,
    handleTrackDragStart,
    cleanupTrackDrag
  }
}
