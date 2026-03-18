<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  applyMixtapeGlobalTempoTargetsToTracks,
  normalizeMixtapeGlobalBpmEnvelopePoints,
  resolveDefaultGlobalBpmFromTracks,
  resolveMixtapeGlobalBpmVisualRange
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import {
  applyMixtapeGlobalTempoSnapshot,
  mixtapeGlobalTempoEnvelope
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import {
  mapTrackBpmToYPercent,
  mapTrackBpmYPercentToValue,
  buildTrackBpmEnvelopePolylineByControlPoints
} from '@renderer/composables/mixtape/trackTempoVisual'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

const props = defineProps<{
  visible: boolean
  playlistId: string
  tracks: MixtapeTrack[]
  timelineContentWidth: number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
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
  x: number
  y: number
  bpm: number
  labelPlacement: 'above' | 'below'
  labelAlign: 'center' | 'left' | 'right'
  isBoundary: boolean
}

const dragState = ref<DragState | null>(null)
let persistTimer: ReturnType<typeof setTimeout> | null = null

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

const defaultBpm = computed(() => resolveDefaultGlobalBpmFromTracks(props.tracks))

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

const bpmPolyline = computed(() =>
  buildTrackBpmEnvelopePolylineByControlPoints({
    points: effectivePoints.value,
    durationSec: timelineDurationSec.value,
    baseBpm: visualRange.value.baseBpm,
    minBpm: visualRange.value.minBpm,
    maxBpm: visualRange.value.maxBpm
  })
)

const pointDots = computed<PointDot[]>(() =>
  effectivePoints.value.map((point, index) => {
    const durationSec = Math.max(0.0001, timelineDurationSec.value)
    const x = Math.max(0, Math.min(100, (Number(point.sec) / durationSec) * 100))
    const y = mapTrackBpmToYPercent(
      Number(point.bpm),
      visualRange.value.baseBpm,
      visualRange.value.minBpm,
      visualRange.value.maxBpm
    )
    return {
      index,
      x,
      y,
      bpm: Number(point.bpm),
      labelPlacement: y <= 16 ? 'below' : 'above',
      labelAlign: x <= 6 ? 'left' : x >= 94 ? 'right' : 'center',
      isBoundary: index === 0 || index === effectivePoints.value.length - 1
    }
  })
)

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
  const xRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const yRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  const sec = Number((xRatio * Math.max(0, timelineDurationSec.value)).toFixed(4))
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
  if (!props.visible) return
  const point = resolveStagePointFromMouse(event)
  if (!point) return
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
  const stage = document.querySelector('.timeline-master-bpm__stage') as HTMLElement | null
  const rect = stage?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) return
  const xRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const yRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  const nextPoints = clonePoints(effectivePoints.value)
  const targetPoint = nextPoints[currentDragState.pointIndex]
  if (!targetPoint) return
  const isBoundary =
    currentDragState.pointIndex === 0 || currentDragState.pointIndex === nextPoints.length - 1
  if (!isBoundary) {
    targetPoint.sec = Number((xRatio * Math.max(0, timelineDurationSec.value)).toFixed(4))
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
  <div v-if="visible" class="timeline-master-bpm">
    <div
      class="timeline-master-bpm__stage"
      :style="{ width: `${timelineContentWidth}px` }"
      @mousedown.stop.prevent="handleStageMouseDown"
    >
      <div class="timeline-master-bpm__title">MASTER BPM</div>
      <svg class="timeline-master-bpm__svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line class="timeline-master-bpm__midline" x1="0" y1="50" x2="100" y2="50"></line>
        <polyline class="timeline-master-bpm__line" :points="bpmPolyline"></polyline>
      </svg>
      <div class="timeline-master-bpm__points">
        <button
          v-for="point in pointDots"
          :key="`mix-bpm-${point.index}`"
          class="timeline-master-bpm__point"
          :class="{ 'is-boundary': point.isBoundary }"
          type="button"
          :style="{ left: `${point.x}%`, top: `${point.y}%` }"
          @mousedown.stop.prevent="resolvePointIndexFromEvent($event, point.index)"
          @dblclick.stop.prevent="handlePointDoubleClick(point.index)"
          @contextmenu.stop.prevent="handlePointContextMenu(point.index, $event)"
        >
          <span
            class="timeline-master-bpm__point-label"
            :class="[`is-${point.labelPlacement}`, `is-align-${point.labelAlign}`]"
          >
            {{ Math.round(point.bpm) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.timeline-master-bpm {
  position: relative;
  height: 88px;
  padding: 8px 0 12px;
}

.timeline-master-bpm__stage {
  position: relative;
  height: 100%;
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(29, 46, 66, 0.95), rgba(15, 26, 40, 0.98));
  border: 1px solid rgba(125, 226, 255, 0.24);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  overflow: hidden;
  cursor: crosshair;
}

.timeline-master-bpm__title {
  position: absolute;
  left: 12px;
  top: 8px;
  z-index: 2;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: rgba(213, 244, 255, 0.82);
}

.timeline-master-bpm__svg,
.timeline-master-bpm__points {
  position: absolute;
  inset: 0;
}

.timeline-master-bpm__midline {
  stroke: rgba(255, 255, 255, 0.1);
  stroke-width: 0.8;
  stroke-dasharray: 3 3;
}

.timeline-master-bpm__line {
  fill: none;
  stroke: #7de2ff;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.timeline-master-bpm__point {
  position: absolute;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  margin-top: -6px;
  border-radius: 999px;
  border: 2px solid #09131f;
  background: #7de2ff;
  box-shadow: 0 0 0 2px rgba(125, 226, 255, 0.18);
}

.timeline-master-bpm__point.is-boundary {
  background: #ffd86e;
  box-shadow: 0 0 0 2px rgba(255, 216, 110, 0.18);
}

.timeline-master-bpm__point-label {
  position: absolute;
  left: 50%;
  min-width: 28px;
  transform: translateX(-50%);
  font-size: 10px;
  line-height: 1;
  color: rgba(240, 248, 255, 0.88);
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
