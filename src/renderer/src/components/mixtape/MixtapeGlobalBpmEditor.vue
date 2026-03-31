<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '@renderer/composables/useI18n'
import {
  BASE_PX_PER_SEC,
  GRID_BEAT4_LINE_WIDTH,
  GRID_BEAT_LINE_WIDTH,
  MIXTAPE_WIDTH_SCALE,
  resolveTimelineGridBarWidth,
  TIMELINE_SIDE_PADDING_PX
} from '@renderer/composables/mixtape/constants'
import { resolveRoundedTimelineAbsolutePx } from '@renderer/composables/mixtape/timelinePixelMath'
import {
  applyMixtapeGlobalTempoTargetsToTracks,
  normalizeMixtapeGlobalBpmEnvelopePoints,
  resolveDefaultGlobalBpmFromTracks,
  resolveMixtapeGlobalBpmVisualRange,
  sampleMixtapeGlobalBpmAtSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import { createMixtapeMasterGrid } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  applyMixtapeGlobalTempoSnapshot,
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoPhaseOffsetSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import {
  mapTrackBpmToYPercent,
  mapTrackBpmYPercentToValue
} from '@renderer/composables/mixtape/trackTempoVisual'
import { roundTrackTempoSec } from '@renderer/composables/mixtape/trackTempoModel'
import {
  MASTER_BPM_DRAG_STEP_PX,
  buildPointGridBeatMap,
  buildTrackStartBeatById,
  buildTrackTargetSignature,
  clonePoints,
  cloneTracks,
  resolveLockedPointSec,
  resolveTrackStartSec
} from './mixtapeGlobalBpmEditorShared'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'
import type { BpmDragPointer } from './mixtapeGlobalBpmEditorShared'
import { resizeCanvasWithScaleMetrics } from '@renderer/utils/canvasScale'

const props = defineProps<{
  visible: boolean
  expanded: boolean
  playlistId: string
  tracks: MixtapeTrack[]
  heightPx: number
  renderZoomLevel: number
  timelineScrollLeft: number
  timelineViewportWidth: number
  playheadSec: number
  playheadVisible: boolean
  timelineContentWidth: number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  pushExternalUndoStep: (undo: (() => boolean) | null | undefined) => void
  onTracksSync?: (nextTracks: MixtapeTrack[]) => void
  onEnvelopePreviewChanged?: () => void
  onEnvelopeCommitted?: () => void
}>()

type DragState = {
  pointIndices: number[]
  undoPoints: MixtapeBpmPoint[]
  basePoints: MixtapeBpmPoint[]
  beforeTracks: MixtapeTrack[]
  startBeatByTrackId: Map<string, number>
  startPointer?: BpmDragPointer
  pointGridBeats: Map<number, number>
}

type PointDot = {
  index: number
  xPx: number
  y: number
  yPx: number
  bpm: number
  labelPlacement: 'above' | 'below'
  labelAlign: 'center' | 'left' | 'right'
  isBoundary: boolean
  isActive: boolean
  edge: 'start' | 'end' | null
}

type CollapsedPointChip = {
  key: string
  xPx: number
  label: string
}

type ProjectedTrackGridLine = {
  key: string
  sec: number
  leftPx: number
  level: 'bar' | 'beat4' | 'beat'
}

const dragState = ref<DragState | null>(null)
const ghostPointState = ref<{ sec: number; bpm: number } | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
let persistTimer: ReturnType<typeof setTimeout> | null = null
let previewTrackSyncRaf = 0
let gridCanvasRaf = 0
const pendingTrackStartSecPersist = new Map<string, number>()
const { t } = useI18n()

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const timelineDurationSec = computed(() =>
  Math.max(
    0,
    ...props.tracks.map((track) => {
      const startSec = Number(track.startSec)
      const durationSec = Math.max(0, Number(props.resolveTrackDurationSeconds(track)) || 0)
      const safeStartSec = Number.isFinite(startSec) && startSec >= 0 ? startSec : 0
      return safeStartSec + durationSec
    })
  )
)

const shouldShowLane = computed(() => props.visible && timelineDurationSec.value > 0)
const shouldRenderEditor = computed(() => shouldShowLane.value && props.expanded)
const defaultBpm = computed(() => resolveDefaultGlobalBpmFromTracks(props.tracks))
const pxPerSec = computed(
  () => BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE * Math.max(0.1, Number(props.renderZoomLevel) || 0.1)
)

const resolveTimelineXPx = (sec: number) =>
  clampNumber(
    resolveRoundedTimelineAbsolutePx(sec, pxPerSec.value),
    TIMELINE_SIDE_PADDING_PX,
    Math.max(
      TIMELINE_SIDE_PADDING_PX,
      Number(props.timelineContentWidth) - TIMELINE_SIDE_PADDING_PX
    )
  )

const resolveTimelineSecByLocalXPx = (xPx: number) => {
  return clampNumber(
    Math.max(0, Number(xPx) - TIMELINE_SIDE_PADDING_PX) / Math.max(0.0001, pxPerSec.value),
    0,
    Math.max(0, timelineDurationSec.value)
  )
}

const resolveRoundedTimelineSec = (sec: number) =>
  roundTrackTempoSec(clampNumber(Number(sec) || 0, 0, Math.max(0, timelineDurationSec.value)))

const plotHeightPx = computed(() => Math.max(1, Math.max(0, Number(props.heightPx) || 0) - 2))

const resolvePlotYPx = (yPercent: number) =>
  Number(((clampNumber(Number(yPercent) || 0, 0, 100) / 100) * plotHeightPx.value).toFixed(3))

const effectivePoints = computed(() =>
  normalizeMixtapeGlobalBpmEnvelopePoints(
    mixtapeGlobalTempoEnvelope.value,
    timelineDurationSec.value,
    defaultBpm.value
  )
)

const visualRange = computed(() =>
  resolveMixtapeGlobalBpmVisualRange({
    tracks: props.tracks,
    points: effectivePoints.value
  })
)

const bpmPolyline = computed(() => {
  if (!effectivePoints.value.length || props.timelineContentWidth <= 0) return ''
  return effectivePoints.value
    .map((point) => {
      const x = resolveTimelineXPx(Number(point.sec)).toFixed(3)
      const yPercent = mapTrackBpmToYPercent(
        Number(point.bpm),
        visualRange.value.baseBpm,
        visualRange.value.minBpm,
        visualRange.value.maxBpm
      )
      const y = resolvePlotYPx(yPercent).toFixed(3)
      return `${x},${y}`
    })
    .join(' ')
})

const bpmPolygon = computed(() => {
  const line = bpmPolyline.value
  if (!line) return ''
  const width = Math.max(1, props.timelineContentWidth)
  const height = Math.max(1, plotHeightPx.value)
  return `0,${height} ${line} ${width},${height}`
})

const pointDots = computed<PointDot[]>(() => {
  const dragIndices = dragState.value?.pointIndices || []
  return effectivePoints.value.map((point, index) => {
    const xPx = resolveTimelineXPx(Number(point.sec))
    const y = mapTrackBpmToYPercent(
      Number(point.bpm),
      visualRange.value.baseBpm,
      visualRange.value.minBpm,
      visualRange.value.maxBpm
    )
    const yPx = resolvePlotYPx(y)
    const totalWidth = Math.max(1, Number(props.timelineContentWidth) || 1)
    const xRatio = xPx / totalWidth
    const isBoundary = index === 0 || index === effectivePoints.value.length - 1
    const isActive = dragIndices.includes(index)
    return {
      index,
      xPx,
      y,
      yPx,
      bpm: Number(point.bpm),
      labelPlacement: yPx <= 34 ? 'below' : 'above',
      labelAlign: xRatio <= 0.08 ? 'left' : xRatio >= 0.92 ? 'right' : 'center',
      isBoundary,
      isActive,
      edge: !isBoundary ? null : index === 0 ? 'start' : 'end'
    }
  })
})

const estimateCollapsedChipWidth = (label: string) => Math.max(58, 18 + label.length * 6)

const buildCollapsedChipLabel = (bpms: number[]) => {
  const labels = Array.from(new Set(bpms.map((bpm) => formatBpmLabel(bpm))))
  if (!labels.length) return currentBpmText.value
  if (labels.length === 1) return `BPM ${labels[0]}`
  return labels.length === 2
    ? `BPM ${labels[0]}/${labels[1]}`
    : `BPM ${labels[0]}+${labels.length - 1}`
}

const collapsedPointChips = computed<CollapsedPointChip[]>(() => {
  const displayPoints = effectivePoints.value.filter(
    (point, index, points) =>
      index === 0 || formatBpmLabel(point.bpm) !== formatBpmLabel(points[index - 1]?.bpm)
  )
  if (!displayPoints.length) return []

  const chips: CollapsedPointChip[] = []
  const gapPx = 10
  let cluster: { indices: number[]; startXPx: number; bpms: number[] } | null = null

  const flushCluster = () => {
    if (!cluster) return
    const label = buildCollapsedChipLabel(cluster.bpms)
    chips.push({ key: `collapsed-bpm-${cluster.indices.join('-')}`, xPx: cluster.startXPx, label })
    cluster = null
  }

  for (let index = 0; index < displayPoints.length; index += 1) {
    const point = displayPoints[index]
    const xPx = resolveTimelineXPx(Number(point.sec))
    const label = `BPM ${formatBpmLabel(point.bpm)}`
    const estimatedWidth = estimateCollapsedChipWidth(label)
    if (!cluster) {
      cluster = { indices: [index], startXPx: xPx, bpms: [Number(point.bpm)] }
      continue
    }

    const clusterLabel = buildCollapsedChipLabel(cluster.bpms)
    const clusterWidth = estimateCollapsedChipWidth(clusterLabel)
    const clusterRight = cluster.startXPx + clusterWidth
    const nextLeft = xPx
    if (nextLeft <= clusterRight + gapPx) {
      cluster.indices.push(index)
      cluster.bpms.push(Number(point.bpm))
      continue
    }

    flushCluster()
    cluster = { indices: [index], startXPx: xPx, bpms: [Number(point.bpm)] }
  }

  flushCluster()
  return chips
})

const ghostPointDot = computed(() => {
  const state = ghostPointState.value
  if (!state) return null
  const xPx = resolveTimelineXPx(state.sec)
  const y = mapTrackBpmToYPercent(
    state.bpm,
    visualRange.value.baseBpm,
    visualRange.value.minBpm,
    visualRange.value.maxBpm
  )
  return {
    xPx,
    yPx: resolvePlotYPx(y)
  }
})

const visibleGridLines = computed<ProjectedTrackGridLine[]>(() => {
  const viewportStartSec = resolveTimelineSecByLocalXPx(Number(props.timelineScrollLeft) || 0)
  const viewportEndSec = resolveTimelineSecByLocalXPx(
    Math.max(0, Number(props.timelineScrollLeft) || 0) +
      Math.max(0, Number(props.timelineViewportWidth) || 0)
  )
  const masterGrid = createMixtapeMasterGrid({
    points: effectivePoints.value,
    phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
    fallbackBpm: defaultBpm.value
  })
  const beatBufferSec = (32 * 60) / Math.max(1, defaultBpm.value)
  const minSec = Math.max(0, viewportStartSec - beatBufferSec)
  const maxSec = Math.max(Math.max(0, timelineDurationSec.value), viewportEndSec + beatBufferSec)
  return masterGrid
    .buildVisibleGridLines(Number(props.renderZoomLevel) || 0, {
      minSec,
      maxSec
    })
    .map((line) => {
      const safeSec = resolveRoundedTimelineSec(line.sec)
      return {
        key: `master:${line.level}:${Math.round(safeSec * 1000)}`,
        sec: safeSec,
        leftPx: resolveTimelineXPx(safeSec),
        level: line.level
      }
    })
})

const resolveSnappedTimelineSec = (
  sec: number,
  range?: {
    minSec?: number
    maxSec?: number
  }
) => {
  const safeDurationSec = Math.max(0, timelineDurationSec.value)
  const safeMinSec = clampNumber(Number(range?.minSec) || 0, 0, safeDurationSec)
  const safeMaxSec = clampNumber(
    Number.isFinite(Number(range?.maxSec)) ? Number(range?.maxSec) : safeDurationSec,
    safeMinSec,
    safeDurationSec
  )
  const safeSec = clampNumber(Number(sec) || 0, safeMinSec, safeMaxSec)
  const candidateMap = new Map<number, number>()
  const pushCandidate = (candidateSec: number) => {
    const roundedSec = roundTrackTempoSec(candidateSec)
    if (roundedSec < safeMinSec - 0.0001 || roundedSec > safeMaxSec + 0.0001) return
    candidateMap.set(Math.round(roundedSec * 10000), roundedSec)
  }

  for (const line of visibleGridLines.value) {
    pushCandidate(line.sec)
  }

  const candidates = Array.from(candidateMap.values())
  if (!candidates.length) return roundTrackTempoSec(safeSec)

  let nearest = candidates[0]
  let minDiff = Math.abs(nearest - safeSec)
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const diff = Math.abs(candidate - safeSec)
    if (diff < minDiff) {
      nearest = candidate
      minDiff = diff
    }
  }
  return roundTrackTempoSec(clampNumber(nearest, safeMinSec, safeMaxSec))
}

const currentPlayheadSec = computed(() =>
  clampNumber(Number(props.playheadSec) || 0, 0, Math.max(0, timelineDurationSec.value))
)

const currentBpmValue = computed(() =>
  sampleMixtapeGlobalBpmAtSec(effectivePoints.value, currentPlayheadSec.value, defaultBpm.value)
)

const formatBpmLabel = (value: number) => Math.max(1, Math.round(Number(value) || 0)).toString()

const currentBpmLabel = computed(() => formatBpmLabel(currentBpmValue.value))
const currentBpmText = computed(() => `BPM ${currentBpmLabel.value}`)
const interactionHintText = computed(() => t('mixtape.masterTempoLaneDragHint'))

const playheadMarker = computed(() => {
  const xPx = resolveTimelineXPx(currentPlayheadSec.value)
  const width = Math.max(1, Number(props.timelineContentWidth) || 1)
  const ratio = xPx / width
  return {
    xPx,
    align: ratio <= 0.08 ? 'left' : ratio >= 0.92 ? 'right' : 'center'
  }
})

const laneStyle = computed(() => ({
  width: `${Math.max(0, Number(props.timelineContentWidth) || 0)}px`,
  height: `${Math.max(0, Number(props.heightPx) || 0)}px`
}))

const gridCanvasStyle = computed(() => ({
  left: `${Math.max(0, Number(props.timelineScrollLeft) || 0)}px`,
  width: `${Math.max(0, Number(props.timelineViewportWidth) || 0)}px`,
  height: `${Math.max(0, Number(props.heightPx) || 0)}px`
}))

const resolveGridLineVisual = (level: ProjectedTrackGridLine['level']) => {
  if (level === 'bar') {
    return {
      width: resolveTimelineGridBarWidth(Number(props.renderZoomLevel) || 0),
      color: 'var(--mixtape-grid-line-bar)'
    }
  }
  if (level === 'beat4') {
    return { width: GRID_BEAT4_LINE_WIDTH, color: 'var(--mixtape-grid-line-beat4)' }
  }
  return { width: GRID_BEAT_LINE_WIDTH, color: 'var(--mixtape-grid-line-beat)' }
}

const drawGridCanvas = () => {
  const canvas = gridCanvasRef.value
  if (!canvas || !shouldRenderEditor.value) return
  const width = Math.max(0, Math.floor(Number(props.timelineViewportWidth) || 0))
  const height = Math.max(0, Math.floor(Number(props.heightPx) || 0))
  if (!width || !height) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  resizeCanvasWithScaleMetrics(canvas, ctx, width, height, window.devicePixelRatio || 1)
  const scrollLeft = Math.max(0, Number(props.timelineScrollLeft) || 0)
  for (const line of visibleGridLines.value) {
    const visual = resolveGridLineVisual(line.level)
    const x = line.leftPx - scrollLeft - visual.width / 2
    if (x + visual.width < -2 || x > width + 2) continue
    ctx.fillStyle = visual.color
    ctx.fillRect(x, 0, visual.width, height)
  }
}

const scheduleGridCanvasDraw = () => {
  if (gridCanvasRaf) return
  gridCanvasRaf = requestAnimationFrame(() => {
    gridCanvasRaf = 0
    drawGridCanvas()
  })
}

const queueTrackStartSecPersist = (beforeTracks: MixtapeTrack[], afterTracks: MixtapeTrack[]) => {
  const beforeStartSecById = new Map(
    beforeTracks.map((track) => [track.id, resolveTrackStartSec(track)])
  )
  for (const track of afterTracks) {
    const itemId = String(track.id || '').trim()
    if (!itemId) continue
    const beforeStartSec = beforeStartSecById.get(itemId) ?? 0
    const afterStartSec = resolveTrackStartSec(track)
    if (Math.abs(beforeStartSec - afterStartSec) <= 0.0001) {
      pendingTrackStartSecPersist.delete(itemId)
      continue
    }
    pendingTrackStartSecPersist.set(itemId, afterStartSec)
  }
}

const applyPoints = (points: MixtapeBpmPoint[], options?: { persist?: boolean }) => {
  const nextPoints = normalizeMixtapeGlobalBpmEnvelopePoints(
    points,
    timelineDurationSec.value,
    defaultBpm.value
  )
  applyMixtapeGlobalTempoSnapshot({
    playlistId: props.playlistId,
    snapshot: {
      bpmEnvelope: nextPoints,
      bpmEnvelopeDurationSec: timelineDurationSec.value,
      gridPhaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value
    },
    source: 'user'
  })
  props.onEnvelopePreviewChanged?.()
  if (options?.persist) {
    props.onEnvelopeCommitted?.()
    schedulePersist()
  }
}

const flushPersist = async () => {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const playlistId = String(props.playlistId || '').trim()
  if (!playlistId || !window?.electron?.ipcRenderer?.invoke) return
  const startSecEntries = Array.from(pendingTrackStartSecPersist.entries()).map(
    ([itemId, startSec]) => ({
      itemId,
      startSec
    })
  )
  const [bpmEnvelopePersistResult, trackStartPersistResult] = await Promise.allSettled([
    window.electron.ipcRenderer.invoke('mixtape:project:set-bpm-envelope', {
      playlistId,
      bpmEnvelope: effectivePoints.value.map((point) => ({
        sec: Number(point.sec),
        bpm: Number(point.bpm)
      })),
      bpmEnvelopeDurationSec: timelineDurationSec.value,
      gridPhaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value
    }),
    startSecEntries.length > 0
      ? window.electron.ipcRenderer.invoke('mixtape:update-track-start-sec', {
          entries: startSecEntries
        })
      : Promise.resolve(null)
  ])
  if (bpmEnvelopePersistResult.status === 'rejected') {
    console.error('[mixtape] persist global bpm envelope failed', {
      playlistId,
      error: bpmEnvelopePersistResult.reason
    })
  }
  if (trackStartPersistResult.status === 'rejected') {
    console.error('[mixtape] persist track start sec after global bpm edit failed', {
      playlistId,
      count: startSecEntries.length,
      error: trackStartPersistResult.reason
    })
    return
  }
  for (const entry of startSecEntries) {
    pendingTrackStartSecPersist.delete(entry.itemId)
  }
}

const schedulePersist = () => {
  if (persistTimer) {
    clearTimeout(persistTimer)
  }
  persistTimer = setTimeout(() => {
    persistTimer = null
    void flushPersist()
  }, 220)
}

const syncTrackTargets = (params?: {
  previousGlobalPoints?: MixtapeBpmPoint[]
  sourceTracks?: MixtapeTrack[]
  sourceStartBeatByTrackId?: Map<string, number>
  preview?: boolean
}) => {
  if (!effectivePoints.value.length) return
  const previousGlobalPoints = params?.previousGlobalPoints || effectivePoints.value
  const sourceTracks = params?.sourceTracks || props.tracks
  const sourceStartBeatByTrackId =
    params?.sourceStartBeatByTrackId ||
    buildTrackStartBeatById(
      sourceTracks,
      previousGlobalPoints,
      defaultBpm.value,
      mixtapeGlobalTempoPhaseOffsetSec.value
    )
  const nextMasterGrid = createMixtapeMasterGrid({
    points: effectivePoints.value,
    phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
    fallbackBpm: defaultBpm.value
  })
  const warpedTracks = sourceTracks.map((track) => {
    const trackId = String(track.id || '')
    const startBeat =
      sourceStartBeatByTrackId.get(trackId) ??
      nextMasterGrid.mapSecToBeats(resolveTrackStartSec(track))
    return {
      ...track,
      startSec: roundTrackTempoSec(nextMasterGrid.mapBeatsToSec(startBeat))
    }
  })
  const nextTracks = applyMixtapeGlobalTempoTargetsToTracks(warpedTracks, effectivePoints.value)
  const nextSignature = buildTrackTargetSignature(nextTracks)
  const currentSignature = buildTrackTargetSignature(props.tracks)
  const sourceSignature = buildTrackTargetSignature(sourceTracks)
  const changedFromCurrent = nextSignature !== currentSignature
  const changedFromSource = nextSignature !== sourceSignature

  if (!params?.preview) {
    queueTrackStartSecPersist(sourceTracks, nextTracks)
  }
  if (!changedFromSource && !changedFromCurrent) {
    return
  }
  if (changedFromCurrent) {
    props.onTracksSync?.(nextTracks)
  }
}

const cancelPreviewTrackSync = () => {
  if (!previewTrackSyncRaf || typeof cancelAnimationFrame !== 'function') {
    previewTrackSyncRaf = 0
    return
  }
  cancelAnimationFrame(previewTrackSyncRaf)
  previewTrackSyncRaf = 0
}

const flushPreviewTrackSync = () => {
  previewTrackSyncRaf = 0
  const currentDragState = dragState.value
  if (!currentDragState) return
  syncTrackTargets({
    previousGlobalPoints: currentDragState.undoPoints,
    sourceTracks: currentDragState.beforeTracks,
    sourceStartBeatByTrackId: currentDragState.startBeatByTrackId,
    preview: true
  })
}

const schedulePreviewTrackSync = () => {
  if (typeof requestAnimationFrame !== 'function') {
    flushPreviewTrackSync()
    return
  }
  if (previewTrackSyncRaf) return
  previewTrackSyncRaf = requestAnimationFrame(() => {
    flushPreviewTrackSync()
  })
}

const pushUndoSnapshot = (beforePoints: MixtapeBpmPoint[]) => {
  const snapshot = clonePoints(beforePoints)
  props.pushExternalUndoStep(() => {
    applyMixtapeGlobalTempoSnapshot({
      playlistId: props.playlistId,
      snapshot: {
        bpmEnvelope: snapshot,
        bpmEnvelopeDurationSec: timelineDurationSec.value,
        gridPhaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value
      },
      source: 'user'
    })
    syncTrackTargets({
      previousGlobalPoints: snapshot
    })
    props.onEnvelopePreviewChanged?.()
    props.onEnvelopeCommitted?.()
    void flushPersist()
    return true
  })
}

const resolvePointIndexFromEvent = (
  event: MouseEvent,
  pointIndices: number[],
  startPointer?: BpmDragPointer
) => {
  event.preventDefault()
  event.stopPropagation()
  const currentPoints = clonePoints(effectivePoints.value)
  dragState.value = {
    pointIndices,
    undoPoints: currentPoints,
    basePoints: currentPoints,
    beforeTracks: cloneTracks(props.tracks),
    startBeatByTrackId: buildTrackStartBeatById(
      props.tracks,
      currentPoints,
      defaultBpm.value,
      mixtapeGlobalTempoPhaseOffsetSec.value
    ),
    startPointer,
    pointGridBeats: buildPointGridBeatMap(
      currentPoints,
      defaultBpm.value,
      mixtapeGlobalTempoPhaseOffsetSec.value
    )
  }
  window.addEventListener('mousemove', handleWindowMouseMove, { passive: false })
  window.addEventListener('mouseup', handleWindowMouseUp, { passive: true })
}

const resolveStagePointFromMouse = (event: MouseEvent) => {
  const target = stageRef.value
  const rect = target?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) return null
  const xPx = clampNumber(event.clientX - rect.left, 0, rect.width)
  const yRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  const sec = Number(resolveTimelineSecByLocalXPx(xPx).toFixed(4))
  const bpm = Number(
    mapTrackBpmYPercentToValue(
      yRatio * 100,
      visualRange.value.baseBpm,
      visualRange.value.minBpm,
      visualRange.value.maxBpm
    ).toFixed(4)
  )
  return { sec, bpm, clientY: event.clientY }
}

const handleStageMouseMove = (event: MouseEvent) => {
  if (!shouldRenderEditor.value) return
  const point = resolveStagePointFromMouse(event)
  if (!point) return

  point.sec = resolveSnappedTimelineSec(point.sec)
  const lineBpm = sampleMixtapeGlobalBpmAtSec(effectivePoints.value, point.sec, defaultBpm.value)

  ghostPointState.value = {
    sec: point.sec,
    bpm: lineBpm
  }
}

const handleStageMouseLeave = (event: MouseEvent) => {
  ghostPointState.value = null
}

const handleStageMouseDown = (event: MouseEvent) => {
  if (!shouldRenderEditor.value || event.button !== 0) return

  if (event.detail < 2) return

  const point = resolveStagePointFromMouse(event)
  if (!point) return
  point.sec = resolveSnappedTimelineSec(point.sec)

  const lineBpm = Math.round(
    sampleMixtapeGlobalBpmAtSec(effectivePoints.value, point.sec, defaultBpm.value)
  )
  point.bpm = lineBpm

  const undoPoints = clonePoints(effectivePoints.value)
  const nextPoints = normalizeMixtapeGlobalBpmEnvelopePoints(
    [...effectivePoints.value, point],
    timelineDurationSec.value,
    defaultBpm.value
  )
  const pointIndex = nextPoints.findIndex(
    (item) =>
      Math.abs(Number(item.sec) - Number(point.sec)) <= 0.0001 &&
      Math.abs(Number(item.bpm) - Number(point.bpm)) <= 0.0001
  )
  applyPoints(nextPoints)
  const resolvedIndex = pointIndex >= 0 ? pointIndex : nextPoints.length - 1
  dragState.value = {
    pointIndices: [resolvedIndex],
    undoPoints,
    basePoints: clonePoints(nextPoints),
    beforeTracks: cloneTracks(props.tracks),
    startBeatByTrackId: buildTrackStartBeatById(
      props.tracks,
      undoPoints,
      defaultBpm.value,
      mixtapeGlobalTempoPhaseOffsetSec.value
    ),
    startPointer: point,
    pointGridBeats: buildPointGridBeatMap(
      nextPoints,
      defaultBpm.value,
      mixtapeGlobalTempoPhaseOffsetSec.value
    )
  }
  schedulePreviewTrackSync()
  window.addEventListener('mousemove', handleWindowMouseMove, { passive: false })
  window.addEventListener('mouseup', handleWindowMouseUp, { passive: true })
}

const handleWindowMouseMove = (event: MouseEvent) => {
  const currentDragState = dragState.value
  if (!currentDragState || !currentDragState.pointIndices.length || !currentDragState.startPointer)
    return
  event.preventDefault()
  const nextPoints = clonePoints(currentDragState.basePoints)
  const deltaBpm = Math.round(
    ((currentDragState.startPointer.clientY ?? event.clientY) - event.clientY) /
      MASTER_BPM_DRAG_STEP_PX
  )

  for (const pointIndex of currentDragState.pointIndices) {
    const targetPoint = nextPoints[pointIndex]
    const basePoint = currentDragState.basePoints[pointIndex]
    if (!targetPoint || !basePoint) continue
    targetPoint.bpm = Math.round(
      clampNumber(
        Math.round(basePoint.bpm) + deltaBpm,
        visualRange.value.minBpm,
        visualRange.value.maxBpm
      )
    )
  }

  if (currentDragState.pointGridBeats.size > 0) {
    const sortedIndices = [...currentDragState.pointIndices]
      .filter((idx) => idx > 0 && idx < nextPoints.length - 1)
      .sort((a, b) => a - b)
    for (const pointIndex of sortedIndices) {
      const targetPoint = nextPoints[pointIndex]
      if (!targetPoint) continue
      targetPoint.sec = resolveLockedPointSec({
        points: nextPoints,
        pointIndex,
        pointGridBeats: currentDragState.pointGridBeats,
        durationSec: timelineDurationSec.value
      })
    }
  }

  applyPoints(nextPoints)
  schedulePreviewTrackSync()
}

const handleWindowMouseUp = () => {
  const currentDragState = dragState.value
  cancelPreviewTrackSync()
  dragState.value = null
  window.removeEventListener('mousemove', handleWindowMouseMove as EventListener)
  window.removeEventListener('mouseup', handleWindowMouseUp as EventListener)
  if (!currentDragState) return
  syncTrackTargets({
    previousGlobalPoints: currentDragState.undoPoints,
    sourceTracks: currentDragState.beforeTracks,
    sourceStartBeatByTrackId: currentDragState.startBeatByTrackId
  })
  props.onEnvelopeCommitted?.()
  schedulePersist()
  if (JSON.stringify(currentDragState.undoPoints) !== JSON.stringify(effectivePoints.value)) {
    pushUndoSnapshot(currentDragState.undoPoints)
  }
}

const removePointAtIndex = (pointIndex: number) => {
  if (pointIndex <= 0 || pointIndex >= effectivePoints.value.length - 1) return
  const beforePoints = clonePoints(effectivePoints.value)
  applyPoints(
    effectivePoints.value.filter((_, index) => index !== pointIndex),
    { persist: true }
  )
  syncTrackTargets({
    previousGlobalPoints: beforePoints
  })
  pushUndoSnapshot(beforePoints)
}

const handlePointMouseDown = (event: MouseEvent, index: number) => {
  if (event.button !== 0) return
  const pointer = resolveStagePointFromMouse(event)
  resolvePointIndexFromEvent(event, [index], pointer || undefined)
}

const handlePointDoubleClick = (pointIndex: number) => {
  removePointAtIndex(pointIndex)
}

const handlePointContextMenu = (pointIndex: number, event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  removePointAtIndex(pointIndex)
}

onBeforeUnmount(() => {
  if (gridCanvasRaf) {
    cancelAnimationFrame(gridCanvasRaf)
    gridCanvasRaf = 0
  }
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  cancelPreviewTrackSync()
  window.removeEventListener('mousemove', handleWindowMouseMove as EventListener)
  window.removeEventListener('mouseup', handleWindowMouseUp as EventListener)
})

onMounted(() => {
  scheduleGridCanvasDraw()
})

watch(
  () => [
    props.visible,
    props.expanded,
    props.timelineScrollLeft,
    props.timelineViewportWidth,
    props.heightPx,
    props.renderZoomLevel,
    props.timelineContentWidth,
    visibleGridLines.value
      .map((line) => `${line.level}:${Number(line.leftPx).toFixed(4)}`)
      .join('|')
  ],
  () => {
    scheduleGridCanvasDraw()
  },
  { immediate: true, flush: 'post' }
)

watch(
  () => props.expanded,
  (expanded) => {
    if (expanded) {
      scheduleGridCanvasDraw()
      return
    }
    if (dragState.value) {
      handleWindowMouseUp()
      return
    }
    cancelPreviewTrackSync()
    dragState.value = null
    window.removeEventListener('mousemove', handleWindowMouseMove as EventListener)
    window.removeEventListener('mouseup', handleWindowMouseUp as EventListener)
  }
)
</script>

<template>
  <div
    v-if="shouldShowLane"
    class="timeline-master-bpm"
    :class="{ 'is-expanded': props.expanded }"
    :style="laneStyle"
  >
    <div v-if="props.expanded" ref="stageRef" class="timeline-master-bpm__stage">
      <canvas
        ref="gridCanvasRef"
        class="timeline-master-bpm__grid-canvas"
        :style="gridCanvasStyle"
      ></canvas>

      <div
        class="timeline-master-bpm__stage-hit-area"
        @mousedown.stop.prevent="handleStageMouseDown"
        @mousemove="handleStageMouseMove"
        @mouseleave="handleStageMouseLeave"
      ></div>

      <svg
        class="timeline-master-bpm__svg"
        :viewBox="`0 0 ${Math.max(1, timelineContentWidth)} ${Math.max(1, plotHeightPx)}`"
        preserveAspectRatio="none"
      >
        <line
          class="timeline-master-bpm__midline"
          :x1="TIMELINE_SIDE_PADDING_PX"
          :y1="resolvePlotYPx(50)"
          :x2="Math.max(TIMELINE_SIDE_PADDING_PX, timelineContentWidth - TIMELINE_SIDE_PADDING_PX)"
          :y2="resolvePlotYPx(50)"
        ></line>
        <polygon class="timeline-master-bpm__fill" :points="bpmPolygon"></polygon>
        <polyline class="timeline-master-bpm__line" :points="bpmPolyline"></polyline>
      </svg>

      <div
        v-if="ghostPointDot"
        class="timeline-master-bpm__ghost-point"
        :style="{ left: `${ghostPointDot.xPx}px`, top: `${ghostPointDot.yPx}px` }"
      ></div>

      <div
        v-if="props.playheadVisible"
        class="timeline-master-bpm__playhead-chip"
        :class="[`is-align-${playheadMarker.align}`]"
        :style="{ left: `${playheadMarker.xPx}px` }"
      >
        {{ currentBpmText }}
      </div>

      <div class="timeline-master-bpm__points">
        <div
          v-for="point in pointDots"
          :key="`mix-bpm-${point.index}`"
          class="timeline-master-bpm__point-wrap"
          :style="{ left: `${point.xPx}px`, top: `${point.yPx}px` }"
        >
          <button
            class="timeline-master-bpm__point"
            :class="[
              { 'is-boundary': point.isBoundary, 'is-active': point.isActive },
              point.edge ? `is-edge-${point.edge}` : ''
            ]"
            type="button"
            @mousedown.stop.prevent="handlePointMouseDown($event, point.index)"
            @dblclick.stop.prevent="handlePointDoubleClick(point.index)"
            @contextmenu.stop.prevent="handlePointContextMenu(point.index, $event)"
          ></button>
          <span
            v-if="point.isActive"
            class="timeline-master-bpm__point-label"
            :class="[`is-${point.labelPlacement}`, `is-align-${point.labelAlign}`]"
          >
            {{ formatBpmLabel(point.bpm) }}
          </span>
          <span
            v-else
            class="timeline-master-bpm__point-hint"
            :class="[`is-${point.labelPlacement}`, `is-align-${point.labelAlign}`]"
          >
            {{ interactionHintText }}
          </span>
        </div>
      </div>
    </div>

    <div
      v-else
      class="timeline-master-bpm__collapsed-stage"
      @mousedown.stop.prevent
      @click.stop.prevent
    >
      <template v-if="collapsedPointChips.length">
        <div
          v-for="chip in collapsedPointChips"
          :key="chip.key"
          class="timeline-master-bpm__collapsed-chip"
          :style="{ left: `${chip.xPx}px` }"
        >
          {{ chip.label }}
        </div>
      </template>
      <div v-else class="timeline-master-bpm__collapsed-readout">{{ currentBpmText }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss" src="./MixtapeGlobalBpmEditor.scss"></style>
