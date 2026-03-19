<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { t } from '@renderer/utils/translate'
import {
  BASE_PX_PER_SEC,
  MIXTAPE_WIDTH_SCALE,
  TIMELINE_SIDE_PADDING_PX
} from '@renderer/composables/mixtape/constants'
import {
  applyMixtapeGlobalTempoTargetsToTracks,
  buildFlatMixtapeGlobalBpmEnvelope,
  normalizeMixtapeGlobalBpmEnvelopePoints,
  resolveDefaultGlobalBpmFromTracks,
  resolveMixtapeGlobalBpmVisualRange,
  sampleMixtapeGlobalBpmAtSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import {
  applyMixtapeGlobalTempoSnapshot,
  mixtapeGlobalTempoEnvelope
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import {
  mapTrackBpmToYPercent,
  mapTrackBpmYPercentToValue
} from '@renderer/composables/mixtape/trackTempoVisual'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import { roundTrackTempoSec } from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

const props = defineProps<{
  visible: boolean
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
  pointIndex: number
  beforePoints: MixtapeBpmPoint[]
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
  edge: 'start' | 'end' | null
}

type ProjectedTrackGridLine = {
  key: string
  sec: number
  leftPx: number
  level: 'bar' | 'beat4' | 'beat'
}

const dragState = ref<DragState | null>(null)
const stageRef = ref<HTMLElement | null>(null)
let persistTimer: ReturnType<typeof setTimeout> | null = null

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

const shouldRender = computed(() => props.visible && timelineDurationSec.value > 0)
const defaultBpm = computed(() => resolveDefaultGlobalBpmFromTracks(props.tracks))
const pxPerSec = computed(
  () => BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE * Math.max(0.1, Number(props.renderZoomLevel) || 0.1)
)

const resolveTimelineXPx = (sec: number) =>
  clampNumber(
    TIMELINE_SIDE_PADDING_PX + Math.max(0, Number(sec) || 0) * pxPerSec.value,
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

const flatReferencePoints = computed(() =>
  buildFlatMixtapeGlobalBpmEnvelope(timelineDurationSec.value, defaultBpm.value)
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

const pointDots = computed<PointDot[]>(() =>
  effectivePoints.value.map((point, index) => {
    const xPx = resolveTimelineXPx(Number(point.sec))
    const y = mapTrackBpmToYPercent(
      Number(point.bpm),
      visualRange.value.baseBpm,
      visualRange.value.minBpm,
      visualRange.value.maxBpm
    )
    const totalWidth = Math.max(1, Number(props.timelineContentWidth) || 1)
    const xRatio = xPx / totalWidth
    const isBoundary = index === 0 || index === effectivePoints.value.length - 1
    return {
      index,
      xPx,
      y,
      yPx: resolvePlotYPx(y),
      bpm: Number(point.bpm),
      labelPlacement: y <= 16 ? 'below' : 'above',
      labelAlign: xRatio <= 0.08 ? 'left' : xRatio >= 0.92 ? 'right' : 'center',
      isBoundary,
      edge: !isBoundary ? null : index === 0 ? 'start' : 'end'
    }
  })
)

const visibleGridLines = computed<ProjectedTrackGridLine[]>(() => {
  const viewportStartSec = resolveTimelineSecByLocalXPx(Number(props.timelineScrollLeft) || 0)
  const viewportEndSec = resolveTimelineSecByLocalXPx(
    Math.max(0, Number(props.timelineScrollLeft) || 0) +
      Math.max(0, Number(props.timelineViewportWidth) || 0)
  )
  const beatBufferSec = (32 * 60) / Math.max(1, defaultBpm.value)
  const minSec = Math.max(0, viewportStartSec - beatBufferSec)
  const maxSec = Math.min(Math.max(0, timelineDurationSec.value), viewportEndSec + beatBufferSec)
  const linePriority = {
    beat: 0,
    beat4: 1,
    bar: 2
  } as const
  const linesByPixel = new Map<string, ProjectedTrackGridLine>()
  const pushGridLine = (line: ProjectedTrackGridLine) => {
    const dedupeKey = `${Math.round(line.leftPx)}`
    const previous = linesByPixel.get(dedupeKey)
    if (!previous || linePriority[line.level] > linePriority[previous.level]) {
      linesByPixel.set(dedupeKey, line)
    }
  }
  const pushBoundaryGridLine = (sec: number) => {
    const safeSec = resolveRoundedTimelineSec(sec)
    if (safeSec < minSec - 0.0001 || safeSec > maxSec + 0.0001) return
    const boundaryLine: ProjectedTrackGridLine = {
      key: `boundary:bar:${Math.round(safeSec * 1000)}`,
      sec: safeSec,
      leftPx: resolveTimelineXPx(safeSec),
      level: 'bar'
    }
    linesByPixel.set(`${Math.round(boundaryLine.leftPx)}`, boundaryLine)
  }

  for (const track of props.tracks) {
    const startSec = Math.max(0, Number(track.startSec) || 0)
    const sourceDurationSec = Math.max(
      0,
      Number(props.resolveTrackSourceDurationSeconds(track)) || 0
    )
    const durationSec = Math.max(0, Number(props.resolveTrackDurationSeconds(track)) || 0)
    if (sourceDurationSec <= 0 || durationSec <= 0) continue
    const snapshot = buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      durationSec,
      zoom: Number(props.renderZoomLevel) || 0
    })
    for (const line of snapshot.visibleGridLines) {
      const timelineSec = startSec + Number(line.sec)
      if (timelineSec < minSec - 0.0001 || timelineSec > maxSec + 0.0001) continue
      pushGridLine({
        key: `${track.id}:${line.level}:${Math.round(timelineSec * 1000)}`,
        sec: resolveRoundedTimelineSec(timelineSec),
        leftPx: resolveTimelineXPx(timelineSec),
        level: line.level
      })
    }
  }

  pushBoundaryGridLine(0)
  pushBoundaryGridLine(timelineDurationSec.value)

  return Array.from(linesByPixel.values()).sort((left, right) => left.leftPx - right.leftPx)
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

const isEdited = computed(
  () => JSON.stringify(effectivePoints.value) !== JSON.stringify(flatReferencePoints.value)
)

const currentPlayheadSec = computed(() =>
  clampNumber(Number(props.playheadSec) || 0, 0, Math.max(0, timelineDurationSec.value))
)

const currentBpmValue = computed(() =>
  sampleMixtapeGlobalBpmAtSec(effectivePoints.value, currentPlayheadSec.value, defaultBpm.value)
)

const formatBpmLabel = (value: number) => {
  const rounded = Math.round((Number(value) || 0) * 10) / 10
  if (Math.abs(rounded - Math.round(rounded)) <= 0.05) {
    return Math.round(rounded).toString()
  }
  return rounded.toFixed(1)
}

const currentBpmLabel = computed(() => formatBpmLabel(currentBpmValue.value))
const currentBpmText = computed(() =>
  t('mixtape.masterTempoLaneCurrentBpm', { bpm: currentBpmLabel.value })
)

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

const clonePoints = (points: MixtapeBpmPoint[]) =>
  points.map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm)
  }))

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
      bpmEnvelopeDurationSec: timelineDurationSec.value
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
  try {
    await window.electron.ipcRenderer.invoke('mixtape:project:set-bpm-envelope', {
      playlistId,
      bpmEnvelope: effectivePoints.value.map((point) => ({
        sec: Number(point.sec),
        bpm: Number(point.bpm)
      })),
      bpmEnvelopeDurationSec: timelineDurationSec.value
    })
  } catch (error) {
    console.error('[mixtape] persist global bpm envelope failed', {
      playlistId,
      error
    })
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

const syncTrackTargets = () => {
  if (!effectivePoints.value.length) return
  const nextTracks = applyMixtapeGlobalTempoTargetsToTracks(props.tracks, effectivePoints.value)
  if (
    JSON.stringify(nextTracks.map((track) => track.bpm)) ===
    JSON.stringify(props.tracks.map((track) => track.bpm))
  ) {
    return
  }
  props.onTracksSync?.(nextTracks)
}

const pushUndoSnapshot = (beforePoints: MixtapeBpmPoint[]) => {
  const snapshot = clonePoints(beforePoints)
  props.pushExternalUndoStep(() => {
    applyMixtapeGlobalTempoSnapshot({
      playlistId: props.playlistId,
      snapshot: {
        bpmEnvelope: snapshot,
        bpmEnvelopeDurationSec: timelineDurationSec.value
      },
      source: 'user'
    })
    syncTrackTargets()
    props.onEnvelopePreviewChanged?.()
    props.onEnvelopeCommitted?.()
    void flushPersist()
    return true
  })
}

const resolvePointIndexFromEvent = (event: MouseEvent, pointIndex: number) => {
  event.preventDefault()
  event.stopPropagation()
  dragState.value = {
    pointIndex,
    beforePoints: clonePoints(effectivePoints.value)
  }
  window.addEventListener('mousemove', handleWindowMouseMove, { passive: false })
  window.addEventListener('mouseup', handleWindowMouseUp, { passive: true })
}

const resolveStagePointFromMouse = (event: MouseEvent) => {
  const target = event.currentTarget as HTMLElement | null
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
  return { sec, bpm }
}

const handleStageMouseDown = (event: MouseEvent) => {
  if (!shouldRender.value) return
  const point = resolveStagePointFromMouse(event)
  if (!point) return
  point.sec = resolveSnappedTimelineSec(point.sec)
  const beforePoints = clonePoints(effectivePoints.value)
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
  dragState.value = {
    pointIndex: pointIndex >= 0 ? pointIndex : nextPoints.length - 1,
    beforePoints
  }
  window.addEventListener('mousemove', handleWindowMouseMove, { passive: false })
  window.addEventListener('mouseup', handleWindowMouseUp, { passive: true })
}

const handleWindowMouseMove = (event: MouseEvent) => {
  const currentDragState = dragState.value
  if (!currentDragState) return
  event.preventDefault()
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) return
  const xPx = clampNumber(event.clientX - rect.left, 0, rect.width)
  const yRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  const nextPoints = clonePoints(effectivePoints.value)
  const targetPoint = nextPoints[currentDragState.pointIndex]
  if (!targetPoint) return
  const isBoundary =
    currentDragState.pointIndex === 0 || currentDragState.pointIndex === nextPoints.length - 1
  if (!isBoundary) {
    const prevPoint = nextPoints[currentDragState.pointIndex - 1]
    const nextPoint = nextPoints[currentDragState.pointIndex + 1]
    targetPoint.sec = resolveSnappedTimelineSec(resolveTimelineSecByLocalXPx(xPx), {
      minSec: prevPoint?.sec,
      maxSec: nextPoint?.sec
    })
  }
  targetPoint.bpm = Number(
    mapTrackBpmYPercentToValue(
      yRatio * 100,
      visualRange.value.baseBpm,
      visualRange.value.minBpm,
      visualRange.value.maxBpm
    ).toFixed(4)
  )
  applyPoints(nextPoints)
}

const handleWindowMouseUp = () => {
  const currentDragState = dragState.value
  dragState.value = null
  window.removeEventListener('mousemove', handleWindowMouseMove as EventListener)
  window.removeEventListener('mouseup', handleWindowMouseUp as EventListener)
  if (!currentDragState) return
  syncTrackTargets()
  props.onEnvelopeCommitted?.()
  schedulePersist()
  if (JSON.stringify(currentDragState.beforePoints) !== JSON.stringify(effectivePoints.value)) {
    pushUndoSnapshot(currentDragState.beforePoints)
  }
}

const removePointAtIndex = (pointIndex: number) => {
  if (pointIndex <= 0 || pointIndex >= effectivePoints.value.length - 1) return
  const beforePoints = clonePoints(effectivePoints.value)
  applyPoints(
    effectivePoints.value.filter((_, index) => index !== pointIndex),
    { persist: true }
  )
  syncTrackTargets()
  pushUndoSnapshot(beforePoints)
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
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  window.removeEventListener('mousemove', handleWindowMouseMove as EventListener)
  window.removeEventListener('mouseup', handleWindowMouseUp as EventListener)
})
</script>

<template>
  <div v-if="shouldRender" class="timeline-master-bpm" :style="laneStyle">
    <div
      ref="stageRef"
      class="timeline-master-bpm__stage"
      @mousedown.stop.prevent="handleStageMouseDown"
    >
      <div class="timeline-master-bpm__header">
        <div class="timeline-master-bpm__title-wrap">
          <div class="timeline-master-bpm__title">{{ t('mixtape.masterBpm') }}</div>
          <div v-if="isEdited" class="timeline-master-bpm__edited-badge">
            {{ t('mixtape.masterTempoLaneEdited') }}
          </div>
        </div>
        <div class="timeline-master-bpm__readout">{{ currentBpmText }}</div>
      </div>

      <div class="timeline-master-bpm__grid">
        <div
          v-for="line in visibleGridLines"
          :key="line.key"
          class="timeline-master-bpm__grid-line"
          :class="[`is-${line.level}`]"
          :style="{ left: `${line.leftPx}px` }"
        ></div>
      </div>

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
        <polyline class="timeline-master-bpm__line" :points="bpmPolyline"></polyline>
      </svg>

      <div
        v-if="props.playheadVisible"
        class="timeline-master-bpm__playhead-chip"
        :class="[`is-align-${playheadMarker.align}`]"
        :style="{ left: `${playheadMarker.xPx}px` }"
      >
        {{ currentBpmLabel }}
      </div>

      <div class="timeline-master-bpm__points">
        <button
          v-for="point in pointDots"
          :key="`mix-bpm-${point.index}`"
          class="timeline-master-bpm__point"
          :class="[{ 'is-boundary': point.isBoundary }, point.edge ? `is-edge-${point.edge}` : '']"
          type="button"
          :style="{ left: `${point.xPx}px`, top: `${point.yPx}px` }"
          @mousedown.stop.prevent="resolvePointIndexFromEvent($event, point.index)"
          @dblclick.stop.prevent="handlePointDoubleClick(point.index)"
          @contextmenu.stop.prevent="handlePointContextMenu(point.index, $event)"
        >
          <span
            class="timeline-master-bpm__point-label"
            :class="[`is-${point.labelPlacement}`, `is-align-${point.labelAlign}`]"
          >
            {{ formatBpmLabel(point.bpm) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.timeline-master-bpm {
  position: relative;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--bg);
}

.timeline-master-bpm__stage {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 0;
  border: 1px solid var(--border);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035) 0%, rgba(255, 255, 255, 0.01) 100%),
    var(--bg-elev);
  overflow: hidden;
  cursor: crosshair;
  border-color: var(--accent);
}

.timeline-master-bpm__header {
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px 0;
  pointer-events: none;
}

.timeline-master-bpm__title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.timeline-master-bpm__title {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--text-weak);
  text-transform: uppercase;
}

.timeline-master-bpm__edited-badge {
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--accent);
  font-size: 10px;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.timeline-master-bpm__readout {
  flex-shrink: 0;
  max-width: 44%;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-weak);
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  text-align: right;
}

.timeline-master-bpm__grid,
.timeline-master-bpm__svg,
.timeline-master-bpm__points {
  position: absolute;
  inset: 0;
}

.timeline-master-bpm__grid {
  z-index: 1;
  pointer-events: none;
}

.timeline-master-bpm__svg {
  z-index: 2;
  pointer-events: none;
}

.timeline-master-bpm__points {
  z-index: 3;
}

.timeline-master-bpm__grid-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 255, 255, 0.12);
}

.timeline-master-bpm__grid-line.is-bar {
  width: 2px;
  background: rgba(255, 255, 255, 0.26);
}

.timeline-master-bpm__grid-line.is-beat4 {
  background: rgba(255, 255, 255, 0.16);
}

.timeline-master-bpm__midline {
  stroke: var(--border);
  stroke-width: 0.8;
  stroke-dasharray: 3 3;
  opacity: 0.8;
}

.timeline-master-bpm__line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.95;
}

.timeline-master-bpm__playhead-chip {
  position: absolute;
  top: 24px;
  z-index: 3;
  min-width: 34px;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.78);
  color: var(--text);
  font-size: 10px;
  line-height: 1.2;
  pointer-events: none;
  transform: translateX(-50%);
}

.timeline-master-bpm__playhead-chip.is-align-left {
  transform: none;
}

.timeline-master-bpm__playhead-chip.is-align-right {
  transform: translateX(-100%);
}

.timeline-master-bpm__point {
  position: absolute;
  width: 10px;
  height: 10px;
  padding: 0;
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  transform: translate(-50%, -50%);
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.65);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: none;
  overflow: visible;
}

.timeline-master-bpm__point.is-boundary {
  background: var(--accent);
  border-color: rgba(0, 0, 0, 0.75);
}

.timeline-master-bpm__point-label {
  position: absolute;
  left: 50%;
  min-width: 28px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.78);
  transform: translateX(-50%);
  font-size: 10px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.96);
  pointer-events: none;
}

.timeline-master-bpm__point-label.is-above {
  bottom: calc(100% + 6px);
}

.timeline-master-bpm__point-label.is-below {
  top: calc(100% + 6px);
}

.timeline-master-bpm__point-label.is-align-left {
  left: 0;
  transform: none;
}

.timeline-master-bpm__point-label.is-align-right {
  left: auto;
  right: 0;
  transform: none;
}
</style>
