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
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import type { MixtapeTrack, TimelineTrackLayout } from '@renderer/composables/mixtape/types'

export const createTimelineTransportTrackDragModule = (ctx: any) => {
  const {
    tracks,
    normalizedRenderZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackStartSecById,
    resolveTimelineSecByX,
    stopTransportForTrackChange,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    persistTrackStartSec,
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

  const findNearestSortedValues = (values: number[], target: number) => {
    if (!values.length) return [] as number[]
    let left = 0
    let right = values.length - 1
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      if ((values[middle] || 0) < target) {
        left = middle + 1
      } else {
        right = middle
      }
    }
    const result = new Set<number>()
    if (values[left] !== undefined) result.add(values[left] as number)
    if (left > 0 && values[left - 1] !== undefined) result.add(values[left - 1] as number)
    if (left + 1 < values.length && values[left + 1] !== undefined) {
      result.add(values[left + 1] as number)
    }
    return Array.from(result)
  }

  const buildTrackVisibleLocalGridSecs = (track: MixtapeTrack) => {
    const durationSec = resolveTrackDurationSeconds(track)
    const sourceDurationSec = resolveTrackSourceDurationSeconds(track)
    if (!Number.isFinite(durationSec) || durationSec <= 0) return [] as number[]
    if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) return [] as number[]
    const lines = buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      durationSec,
      zoom: Number(normalizedRenderZoom.value) || 0
    }).visibleGridLines
    return lines.map((line) => Number(line.sec.toFixed(4)))
  }

  const resolveSnappedStartSecByVisibleGrid = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    currentLocalGridSecs: number[]
    targetTimelineGridSecs: number[]
    boundaryCandidates?: number[]
  }) => {
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    if (!payload.currentLocalGridSecs.length || !payload.targetTimelineGridSecs.length) return null

    let nearestSec: number | null = null
    let nearestDiff = Number.POSITIVE_INFINITY
    for (const localSec of payload.currentLocalGridSecs) {
      const safeLocalSec = Number(localSec)
      if (!Number.isFinite(safeLocalSec) || safeLocalSec < 0) continue
      const nearestTargets = findNearestSortedValues(
        payload.targetTimelineGridSecs,
        rawStartSec + safeLocalSec
      )
      for (const targetSec of nearestTargets) {
        const snappedStartSec = clampNumber(targetSec - safeLocalSec, minStartSec, maxStartSec)
        const diff = Math.abs(snappedStartSec - rawStartSec)
        if (diff < nearestDiff) {
          nearestSec = snappedStartSec
          nearestDiff = diff
        }
      }
    }
    if (Array.isArray(payload.boundaryCandidates)) {
      for (const candidate of payload.boundaryCandidates) {
        const safeCandidate = clampNumber(Number(candidate) || 0, minStartSec, maxStartSec)
        const diff = Math.abs(safeCandidate - rawStartSec)
        if (diff < nearestDiff) {
          nearestSec = safeCandidate
          nearestDiff = diff
        }
      }
    }
    return nearestSec
  }

  const resolveSnappedStartSec = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapAnchorSec: number
    currentAnchorRawSec: number
    stepSec: number
    boundaryCandidates?: number[]
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
    const candidates = [
      clampNumber(snappedStartSec, minStartSec, maxStartSec),
      ...(Array.isArray(payload.boundaryCandidates)
        ? payload.boundaryCandidates
            .map((candidate) => Number(candidate))
            .filter((candidate) => Number.isFinite(candidate))
            .map((candidate) => clampNumber(candidate, minStartSec, maxStartSec))
        : [])
    ]
    let nearestSec = candidates[0]
    let nearestDiff = Math.abs(nearestSec - rawStartSec)
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const diff = Math.abs(candidate - rawStartSec)
      if (diff < nearestDiff) {
        nearestSec = candidate
        nearestDiff = diff
      }
    }
    return nearestSec
  }

  const handleTrackDragMove = (event: MouseEvent) => {
    if (!trackDragState) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const deltaSec = (event.clientX - trackDragState.startClientX) / pxPerSec
    const rawStartSec = Math.max(0, trackDragState.initialStartSec + deltaSec)
    const dragBounds = resolveTrackDragBounds(trackDragState.snapshotTracks, trackDragState.trackId)
    const clampedRawStartSec = clampNumber(rawStartSec, dragBounds.minStart, dragBounds.maxStart)
    let nextStartSec = clampedRawStartSec
    const currentTrackForSnap = findTrack(trackDragState.trackId)
    const snapStepBeats = resolveVisibleGridSnapStepBeats()
    const previousTrack = findTrack(trackDragState.previousTrackId)
    if (previousTrack) {
      const previousStartSec = resolveTrackStartSecById(previousTrack.id)
      const previousTimelineGridSecs = buildTrackVisibleLocalGridSecs(previousTrack).map((sec) =>
        Number((previousStartSec + sec).toFixed(4))
      )
      const currentLocalGridSecs = currentTrackForSnap
        ? buildTrackVisibleLocalGridSecs(currentTrackForSnap)
        : []
      const snappedStartSec = resolveSnappedStartSecByVisibleGrid({
        rawStartSec: clampedRawStartSec,
        minStartSec: dragBounds.minStart,
        maxStartSec: dragBounds.maxStart,
        currentLocalGridSecs,
        targetTimelineGridSecs: previousTimelineGridSecs,
        boundaryCandidates: [dragBounds.minStart]
      })
      if (typeof snappedStartSec === 'number') {
        nextStartSec = snappedStartSec
      }
    }
    if (currentTrackForSnap) {
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
          stepSec: snapStepSec,
          boundaryCandidates: [dragBounds.minStart]
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
    const currentStartSec = resolveTrackStartSecById(currentTrack.id)
    const shouldUpdateStart = Math.abs(nextStartSec - currentStartSec) > 0.0001
    if (!shouldUpdateStart) return
    const nextTrack: MixtapeTrack = {
      ...currentTrack,
      startSec: nextStartSec
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
    if (!startChanged) return
    void persistTrackStartSec([
      {
        itemId: targetTrackId,
        startSec: Number(currentStartSec)
      }
    ])
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
