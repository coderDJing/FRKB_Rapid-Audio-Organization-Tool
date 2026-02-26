<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import MixtapeOutputDialog from '@renderer/components/mixtapeOutputDialog.vue'
import MixtapeBeatAlignDialog from '@renderer/components/MixtapeBeatAlignDialog.vue'
import ColumnHeaderContextMenu from '@renderer/pages/modules/songsArea/ColumnHeaderContextMenu.vue'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useMixtape } from '@renderer/composables/useMixtape'
import { createMixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import { useMixtapeAutoGainDialog } from '@renderer/composables/mixtape/useMixtapeAutoGainDialog'
import { useMixtapeEnvelopePreview } from '@renderer/composables/mixtape/useMixtapeEnvelopePreview'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import type {
  MixtapeEnvelopeParamId,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

const {
  t,
  titleLabel,
  mixtapePlaylistId,
  mixtapeMenus,
  handleTitleOpenDialog,
  mixtapeRawItems,
  tracks,
  laneIndices,
  laneHeight,
  laneTracks,
  renderZoomLevel,
  resolveTrackDurationSeconds,
  resolveTrackFirstBeatSeconds,
  resolveTrackBlockStyle,
  resolveTrackTitle,
  resolveTrackTitleWithOriginalMeta,
  formatTrackBpm,
  formatTrackKey,
  isRawWaveformLoading,
  preRenderState,
  preRenderPercent,
  timelineRootRef,
  rulerRef,
  timelineVisualScale,
  handleTrackDragStart,
  handleTrackContextMenu,
  trackContextMenuVisible,
  trackContextMenuStyle,
  handleTrackMenuAdjustGrid,
  handleTrackMenuToggleMasterTempo,
  trackMenuMasterTempoChecked,
  beatAlignDialogVisible,
  beatAlignTrack,
  handleBeatAlignDialogCancel,
  handleBeatAlignGridDefinitionSave,
  transportPlaying,
  transportDecoding,
  transportPreloading,
  transportPreloadDone,
  transportPreloadTotal,
  transportPreloadPercent,
  playheadVisible,
  playheadTimeLabel,
  timelineDurationLabel,
  rulerMinuteTicks,
  rulerInactiveStyle,
  overviewPlayheadStyle,
  timelinePlayheadStyle,
  handleTransportPlayFromStart,
  handleTransportStop,
  handleRulerSeek,
  transportError,
  timelineScrollWrapRef,
  isTimelinePanning,
  handleTimelinePanStart,
  handleTimelineHorizontalPanStart,
  timelineScrollRef,
  timelineScrollbarOptions,
  timelineViewport,
  timelineContentWidth,
  timelineScrollLeft,
  timelineViewportWidth,
  timelineCanvasRef,
  envelopePreviewRef,
  overviewRef,
  isOverviewDragging,
  handleOverviewMouseDown,
  handleOverviewClick,
  resolveOverviewTrackStyle,
  overviewViewportStyle,
  bpmAnalysisActive,
  bpmAnalysisFailed,
  bpmAnalysisFailedCount,
  outputDialogVisible,
  outputPath,
  outputFormat,
  outputFilename,
  outputRunning,
  outputProgressText,
  outputProgressPercent,
  handleOutputDialogConfirm,
  handleOutputDialogCancel,
  autoGainDialogVisible,
  autoGainReferenceTrackId,
  autoGainReferenceFeedback,
  autoGainBusy,
  autoGainProgressText,
  canStartAutoGain,
  openAutoGainDialog,
  handleAutoGainDialogCancel,
  handleAutoGainDialogConfirm,
  handleAutoGainSelectLoudestReference,
  handleAutoGainSelectQuietestReference
} = useMixtape()

const mixParamOptions = [
  {
    id: 'position',
    labelKey: 'mixtape.mixParamPosition'
  },
  {
    id: 'gain',
    labelKey: 'mixtape.mixParamGain'
  },
  {
    id: 'high',
    labelKey: 'mixtape.mixParamHigh'
  },
  {
    id: 'mid',
    labelKey: 'mixtape.mixParamMid'
  },
  {
    id: 'low',
    labelKey: 'mixtape.mixParamLow'
  },
  {
    id: 'volume',
    labelKey: 'mixtape.mixParamVolume'
  }
] as const

type MixParamId = (typeof mixParamOptions)[number]['id']
type TrackTimingUndoSnapshot = {
  trackId: string
  startSec: number
  bpm?: number
  originalBpm?: number
  masterTempo: boolean
  volumeMuteSegments: MixtapeMuteSegment[]
}

const selectedMixParam = ref<MixParamId>('position')
const isTrackPositionMode = computed(() => selectedMixParam.value === 'position')
const isGainParamMode = computed(() => selectedMixParam.value === 'gain')
const isVolumeParamMode = computed(() => selectedMixParam.value === 'volume')
const isEnvelopeParamMode = computed(() => !isTrackPositionMode.value)
const volumeMuteSelectionMode = ref(false)
const envelopeHintKey = computed(() => {
  if (isVolumeParamMode.value && volumeMuteSelectionMode.value) {
    return 'mixtape.segmentMuteHint'
  }
  return 'mixtape.envelopeEditHint'
})

const {
  trackEnvelopePreviewLegend,
  timelineTrackAreaHeight,
  timelineAdaptiveStyle,
  resolveTrackEnvelopePreviewLines,
  trackEnvelopePreviewViewportStyle
} = useMixtapeEnvelopePreview({
  laneIndices,
  laneHeight,
  timelineVisualScale,
  timelineContentWidth,
  timelineScrollLeft,
  tracks,
  resolveTrackDurationSeconds
})

watch(selectedMixParam, (nextParam) => {
  if (nextParam !== 'volume') {
    volumeMuteSelectionMode.value = false
  }
})

const normalizeTrackTimingSnapshotNumber = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Number(numeric) : undefined
}

const buildTrackTimingUndoSnapshot = (
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

const isTrackTimingSnapshotSame = (
  left: TrackTimingUndoSnapshot | null,
  right: TrackTimingUndoSnapshot | null
) => JSON.stringify(left) === JSON.stringify(right)

const restoreTrackTimingUndoSnapshot = (snapshot: TrackTimingUndoSnapshot) => {
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

const handleLaneTrackMouseDown = (item: TimelineTrackLayout, event: MouseEvent) => {
  if (!isTrackPositionMode.value) return
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
      pushExternalUndoStep(() => restoreTrackTimingUndoSnapshot(beforeSnapshot))
    },
    { once: true }
  )
}
useWaveformPreviewPlayer()
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const autoGainHeaderTranslate = (key: string) => t(key)

const autoGainSongListScrollRef = ref<OverlayScrollbarsComponentRef>(null)
const {
  autoGainColumnMenuVisible,
  autoGainColumnMenuEvent,
  autoGainDialogColumns,
  autoGainSongColumns,
  autoGainSongTotalWidth,
  autoGainDialogSongs,
  autoGainSelectedRowKeys,
  handleAutoGainSongClick,
  handleAutoGainSongDragStart,
  handleAutoGainColumnsUpdate,
  handleAutoGainColumnClick,
  handleAutoGainHeaderContextMenu,
  handleAutoGainToggleColumnVisibility,
  handleOpenAutoGainDialog,
  handleAutoGainDialogCancelClick,
  handleAutoGainDialogConfirmClick,
  handleAutoGainSelectLoudestReferenceClick,
  handleAutoGainSelectQuietestReferenceClick
} = useMixtapeAutoGainDialog({
  mixtapeRawItems,
  tracks,
  autoGainReferenceTrackId,
  openAutoGainDialog,
  handleAutoGainDialogCancel,
  handleAutoGainDialogConfirm,
  handleAutoGainSelectLoudestReference,
  handleAutoGainSelectQuietestReference
})

const handleToggleVolumeMuteSelectionMode = () => {
  if (!isVolumeParamMode.value) return
  volumeMuteSelectionMode.value = !volumeMuteSelectionMode.value
}

const envelopeEditable = computed(() => isEnvelopeParamMode.value)
const {
  resolveActiveEnvelopePolyline,
  resolveActiveEnvelopePointDots,
  resolveVolumeMuteSegmentMasks,
  handleEnvelopePointMouseDown,
  handleEnvelopeStageMouseDown,
  handleEnvelopePointDoubleClick,
  handleEnvelopePointContextMenu,
  canUndoMixParam,
  pushExternalUndoStep,
  undoLastMixParamChange,
  cleanupGainEnvelopeEditor
} = createMixtapeGainEnvelopeEditor({
  tracks,
  renderZoomLevel,
  resolveTrackDurationSeconds,
  resolveTrackFirstBeatSeconds,
  resolveActiveParam: () =>
    isEnvelopeParamMode.value ? (selectedMixParam.value as MixtapeEnvelopeParamId) : null,
  isVolumeMuteSelectionMode: () => isVolumeParamMode.value && volumeMuteSelectionMode.value,
  isEditable: () => envelopeEditable.value
})

const isEditableEventTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase() || ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

const handleUndoMixParam = () => {
  undoLastMixParamChange()
}

const handleUndoKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return
  if (event.isComposing || event.repeat) return
  if (isEditableEventTarget(event.target)) return
  if (beatAlignDialogVisible.value || outputDialogVisible.value || autoGainDialogVisible.value)
    return
  const key = String(event.key || '').toLowerCase()
  const isUndoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
  if (!isUndoShortcut || key !== 'z') return
  if (!canUndoMixParam.value) return
  event.preventDefault()
  handleUndoMixParam()
}

onMounted(() => {
  window.addEventListener('keydown', handleUndoKeydown)
})

onBeforeUnmount(() => {
  try {
    window.removeEventListener('keydown', handleUndoKeydown)
  } catch {}
  cleanupGainEnvelopeEditor()
})
</script>

<template>
  <div class="mixtape-shell">
    <div class="mixtape-title-wrap">
      <titleComponent
        control-prefix="mixtapeWindow"
        max-event-channel="mixtapeWindow-max"
        :title-text="titleLabel"
        :menu-override="mixtapeMenus"
        :enable-menu-hotkeys="false"
        @open-dialog="handleTitleOpenDialog"
      >
      </titleComponent>
    </div>
    <div class="mixtape-window">
      <section class="mixtape-body">
        <div class="mixtape-param-bar">
          <div class="mixtape-param-bar__title">{{ t('mixtape.mixPanelTitle') }}</div>
          <div class="mixtape-param-bar__tabs">
            <button
              v-for="item in mixParamOptions"
              :key="item.id"
              class="mixtape-param-bar__tab"
              :class="[
                `mixtape-param-bar__tab--${item.id}`,
                { 'is-active': selectedMixParam === item.id }
              ]"
              type="button"
              @click="selectedMixParam = item.id"
            >
              {{ t(item.labelKey) }}
            </button>
          </div>
          <div v-if="isEnvelopeParamMode" class="mixtape-param-bar__hint">
            {{ t(envelopeHintKey) }}
          </div>
          <div class="mixtape-param-bar__actions">
            <button
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              type="button"
              :disabled="!canUndoMixParam"
              :title="t('mixtape.undoActionHint')"
              :aria-label="t('mixtape.undoActionHint')"
              @click="handleUndoMixParam"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M6 3.5 2.5 7l3.5 3.5"></path>
                <path d="M3 7h5.5a3.5 3.5 0 1 1 0 7H7.5"></path>
              </svg>
            </button>
            <button
              v-if="selectedMixParam === 'gain'"
              class="button mixtape-param-bar__action-btn"
              type="button"
              :disabled="!canStartAutoGain"
              @click="handleOpenAutoGainDialog"
            >
              {{ t('mixtape.autoGainAction') }}
            </button>
            <button
              v-if="selectedMixParam === 'volume'"
              class="button mixtape-param-bar__action-btn"
              :class="{ 'is-active': volumeMuteSelectionMode }"
              type="button"
              @click="handleToggleVolumeMuteSelectionMode"
            >
              {{ t('mixtape.segmentMuteAction') }}
            </button>
          </div>
        </div>
        <div class="mixtape-main">
          <section ref="timelineRootRef" class="timeline" :style="timelineAdaptiveStyle">
            <div class="timeline-primary-zone">
              <div class="timeline-ruler-wrap">
                <div class="timeline-ruler-stop-float">
                  <button
                    v-if="transportPlaying || transportDecoding"
                    class="timeline-stop-btn"
                    type="button"
                    :title="t('mixtape.stop')"
                    :aria-label="t('mixtape.stop')"
                    @mousedown.stop.prevent
                    @click.stop="handleTransportStop"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <rect x="4" y="4" width="8" height="8" rx="1"></rect>
                    </svg>
                  </button>
                  <button
                    v-else
                    class="timeline-stop-btn"
                    type="button"
                    :title="t('player.play')"
                    :aria-label="t('player.play')"
                    @mousedown.stop.prevent
                    @click.stop="handleTransportPlayFromStart"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <polygon points="5,4 12,8 5,12"></polygon>
                    </svg>
                  </button>
                  <span v-if="transportDecoding" class="timeline-decoding-hint">
                    {{ t('mixtape.transportDecoding') }}
                  </span>
                </div>
                <div ref="rulerRef" class="timeline-ruler" @mousedown="handleRulerSeek">
                  <div class="timeline-ruler__ticks">
                    <div
                      v-for="tick in rulerMinuteTicks"
                      :key="`tick-${tick.sec}-${tick.left}`"
                      class="timeline-ruler__tick"
                      :style="{ left: tick.left }"
                    >
                      <div class="timeline-ruler__tick-line"></div>
                      <div
                        class="timeline-ruler__tick-label"
                        :class="{
                          'timeline-ruler__tick-label--start': tick.align === 'start',
                          'timeline-ruler__tick-label--end': tick.align === 'end'
                        }"
                      >
                        {{ tick.label }}
                      </div>
                    </div>
                  </div>
                  <div class="timeline-ruler__label">
                    {{ playheadTimeLabel }} / {{ timelineDurationLabel }}
                  </div>
                  <div
                    v-if="rulerInactiveStyle"
                    class="timeline-ruler__inactive"
                    :style="rulerInactiveStyle"
                  ></div>
                </div>
              </div>
              <div
                ref="timelineScrollWrapRef"
                class="timeline-scroll-wrap"
                :class="{ 'is-panning': isTimelinePanning }"
                :style="{ height: `${timelineTrackAreaHeight}px` }"
                @mousedown="handleTimelinePanStart"
              >
                <OverlayScrollbarsComponent
                  ref="timelineScrollRef"
                  class="timeline-scroll"
                  :options="timelineScrollbarOptions"
                  element="div"
                  defer
                >
                  <div
                    ref="timelineViewport"
                    class="timeline-viewport"
                    :style="{
                      width: `${timelineContentWidth}px`,
                      '--timeline-scroll-left': `${timelineScrollLeft}px`,
                      '--timeline-viewport-width': `${timelineViewportWidth}px`
                    }"
                  >
                    <div class="timeline-lanes">
                      <div v-if="tracks.length === 0" class="timeline-empty">
                        <div>{{ t('mixtape.trackEmpty') }}</div>
                        <div class="timeline-empty-hint">{{ t('mixtape.trackEmptyHint') }}</div>
                      </div>
                      <template v-else>
                        <div
                          v-for="laneIndex in laneIndices"
                          :key="laneIndex"
                          class="timeline-lane"
                        >
                          <div
                            class="lane-body"
                            :style="{ height: `${laneHeight}px`, minHeight: `${laneHeight}px` }"
                          >
                            <div
                              v-for="item in laneTracks[laneIndex]"
                              :key="`${item.track.id}-${item.startX}`"
                              class="lane-track"
                              :style="resolveTrackBlockStyle(item)"
                              @mousedown.stop="handleLaneTrackMouseDown(item, $event)"
                              @contextmenu.stop.prevent="handleTrackContextMenu(item, $event)"
                            >
                              <svg
                                class="lane-track__envelope-svg"
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                              >
                                <line
                                  class="lane-track__envelope-midline"
                                  :class="{ 'is-hidden': !isEnvelopeParamMode }"
                                  x1="0"
                                  y1="50"
                                  x2="100"
                                  y2="50"
                                ></line>
                                <polyline
                                  class="lane-track__envelope-line"
                                  :class="{ 'is-hidden': !isEnvelopeParamMode }"
                                  :points="resolveActiveEnvelopePolyline(item)"
                                ></polyline>
                              </svg>
                              <div class="lane-track__mute-segments">
                                <div
                                  v-for="segment in resolveVolumeMuteSegmentMasks(item)"
                                  :key="`mute-${item.track.id}-${segment.key}`"
                                  class="lane-track__mute-segment"
                                  :style="{
                                    left: `${segment.left}%`,
                                    width: `${segment.width}%`
                                  }"
                                ></div>
                              </div>
                              <div
                                v-if="isEnvelopeParamMode"
                                class="lane-track__envelope-points"
                                :class="{
                                  'is-segment-mute-mode':
                                    isVolumeParamMode && volumeMuteSelectionMode
                                }"
                                @mousedown.stop.prevent="handleEnvelopeStageMouseDown(item, $event)"
                              >
                                <button
                                  v-if="!(isVolumeParamMode && volumeMuteSelectionMode)"
                                  v-for="point in resolveActiveEnvelopePointDots(item)"
                                  :key="`point-${item.track.id}-${point.index}`"
                                  class="lane-track__envelope-point"
                                  :class="{ 'is-boundary': point.isBoundary }"
                                  type="button"
                                  :style="{
                                    left: `${point.x}%`,
                                    top: `${point.y}%`
                                  }"
                                  @mousedown.stop.prevent="
                                    handleEnvelopePointMouseDown(item, point.index, $event)
                                  "
                                  @dblclick.stop.prevent="
                                    handleEnvelopePointDoubleClick(item, point.index)
                                  "
                                  @contextmenu.stop.prevent="
                                    handleEnvelopePointContextMenu(item, point.index)
                                  "
                                ></button>
                              </div>
                              <div v-if="isTrackPositionMode" class="lane-track__meta">
                                <div class="lane-track__meta-title">
                                  {{ item.track.mixOrder }}.
                                  {{ resolveTrackTitleWithOriginalMeta(item.track) }}
                                </div>
                                <div class="lane-track__meta-sub">
                                  {{ t('mixtape.bpm') }} {{ formatTrackBpm(item.track.bpm) }}
                                  <template v-if="formatTrackKey(item.track.key)">
                                    · {{ t('columns.key') }} {{ formatTrackKey(item.track.key) }}
                                  </template>
                                </div>
                              </div>
                              <div v-if="isRawWaveformLoading(item.track)" class="lane-loading">
                                {{ t('mixtape.rawWaveformLoading') }}
                              </div>
                            </div>
                          </div>
                        </div>
                      </template>
                    </div>
                  </div>
                </OverlayScrollbarsComponent>
                <canvas ref="timelineCanvasRef" class="timeline-waveform-canvas"></canvas>
                <div v-if="preRenderState.active" class="timeline-preload">
                  <div class="preload-card">
                    <div class="preload-title">
                      {{ t('mixtape.waveformPreparing') }} {{ preRenderPercent }}%
                    </div>
                    <div class="preload-bar">
                      <div
                        class="preload-bar__fill"
                        :style="{ width: `${preRenderPercent}%` }"
                      ></div>
                    </div>
                    <div class="preload-sub">
                      {{ preRenderState.done }} / {{ preRenderState.total }}
                    </div>
                  </div>
                </div>
              </div>
              <div v-if="transportError" class="timeline-transport-error">
                {{ transportError }}
              </div>
              <div class="timeline-envelope-preview">
                <div class="timeline-envelope-preview__legend">
                  <span
                    v-for="legend in trackEnvelopePreviewLegend"
                    :key="`envelope-preview-legend-${legend.key}`"
                    class="timeline-envelope-preview__legend-item"
                  >
                    <span
                      class="timeline-envelope-preview__legend-dot"
                      :style="{ backgroundColor: legend.color }"
                    ></span>
                    {{ legend.label }}
                  </span>
                </div>
                <div
                  ref="envelopePreviewRef"
                  class="timeline-envelope-preview__stage"
                  :class="{ 'is-dragging': isTimelinePanning }"
                  @mousedown="handleTimelineHorizontalPanStart"
                >
                  <div v-if="tracks.length === 0" class="timeline-envelope-preview__empty">
                    {{ t('mixtape.trackEmptyHint') }}
                  </div>
                  <div
                    v-else
                    class="timeline-envelope-preview__viewport"
                    :style="trackEnvelopePreviewViewportStyle"
                  >
                    <div class="timeline-envelope-preview__lanes">
                      <div
                        v-for="laneIndex in laneIndices"
                        :key="`envelope-preview-${laneIndex}`"
                        class="timeline-envelope-preview__lane"
                      >
                        <div
                          v-for="item in laneTracks[laneIndex]"
                          :key="`envelope-preview-${item.track.id}`"
                          class="timeline-envelope-preview__track"
                          :style="resolveTrackBlockStyle(item)"
                        >
                          <div class="timeline-envelope-preview__mute-segments">
                            <div
                              v-for="segment in resolveVolumeMuteSegmentMasks(item)"
                              :key="`envelope-preview-mute-${item.track.id}-${segment.key}`"
                              class="timeline-envelope-preview__mute-segment"
                              :style="{
                                left: `${segment.left}%`,
                                width: `${segment.width}%`
                              }"
                            ></div>
                          </div>
                          <svg
                            class="timeline-envelope-preview__track-svg"
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                          >
                            <polyline
                              v-for="line in resolveTrackEnvelopePreviewLines(item)"
                              :key="`envelope-preview-${item.track.id}-${line.key}`"
                              class="timeline-envelope-preview__line"
                              :class="`timeline-envelope-preview__line--${line.key}`"
                              :points="line.points"
                              :style="{ stroke: line.color, strokeWidth: line.strokeWidth }"
                            ></polyline>
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div
                v-if="playheadVisible && timelinePlayheadStyle"
                class="timeline-primary-playhead"
                :style="timelinePlayheadStyle"
              ></div>
            </div>
            <div class="timeline-overview">
              <div
                ref="overviewRef"
                class="overview-stage"
                :class="{ 'is-dragging': isOverviewDragging }"
                @mousedown="handleOverviewMouseDown"
                @click="handleOverviewClick"
              >
                <div class="overview-lanes">
                  <div
                    v-for="laneIndex in laneIndices"
                    :key="`overview-${laneIndex}`"
                    class="overview-lane"
                  >
                    <div
                      v-for="item in laneTracks[laneIndex]"
                      :key="`overview-${item.track.id}`"
                      class="overview-track"
                      :style="resolveOverviewTrackStyle(item)"
                    ></div>
                  </div>
                </div>
                <div
                  v-if="playheadVisible && overviewPlayheadStyle"
                  class="overview-playhead"
                  :style="overviewPlayheadStyle"
                ></div>
                <div class="overview-viewport" :style="overviewViewportStyle"></div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
    <div v-if="transportPreloading" class="mixtape-decode-mask">
      <div class="bpm-loading-card">
        <div class="bpm-loading-title">{{ t('mixtape.transportPreloading') }}</div>
        <div class="bpm-loading-sub">{{ t('mixtape.transportPreloadingHint') }}</div>
        <div class="bpm-loading-sub">
          {{
            t('mixtape.transportPreloadingProgress', {
              done: transportPreloadDone,
              total: transportPreloadTotal,
              percent: transportPreloadPercent
            })
          }}
        </div>
      </div>
    </div>
    <div v-if="bpmAnalysisActive" class="mixtape-bpm-mask">
      <div class="bpm-loading-card">
        <div class="bpm-loading-title">{{ t('mixtape.bpmAnalyzing') }}</div>
        <div class="bpm-loading-sub">{{ t('mixtape.bpmAnalyzingHint') }}</div>
      </div>
    </div>
    <div v-else-if="bpmAnalysisFailed" class="mixtape-bpm-failed">
      <div class="bpm-loading-card is-error">
        <div class="bpm-loading-title">{{ t('mixtape.bpmAnalyzeFailed') }}</div>
        <div class="bpm-loading-sub">
          {{ t('mixtape.bpmAnalyzeFailedHint', { count: bpmAnalysisFailedCount }) }}
        </div>
      </div>
    </div>
    <div v-if="autoGainBusy && !autoGainDialogVisible" class="mixtape-auto-gain-mask">
      <div class="bpm-loading-card">
        <div class="bpm-loading-title">{{ t('mixtape.autoGainRunning') }}</div>
        <div class="bpm-loading-sub">{{ autoGainProgressText }}</div>
      </div>
    </div>
    <div v-if="outputRunning" class="mixtape-output-mask">
      <div class="bpm-loading-card">
        <div class="bpm-loading-title">{{ t('mixtape.outputRunning') }}</div>
        <div class="bpm-loading-sub">{{ outputProgressText }}</div>
        <div class="preload-bar">
          <div class="preload-bar__fill" :style="{ width: `${outputProgressPercent}%` }"></div>
        </div>
      </div>
    </div>
    <div v-if="autoGainDialogVisible" class="mixtape-auto-gain-dialog">
      <div class="mixtape-auto-gain-dialog__card">
        <div class="mixtape-auto-gain-dialog__title">{{ t('mixtape.autoGainDialogTitle') }}</div>
        <div class="mixtape-auto-gain-dialog__hint">{{ t('mixtape.autoGainDialogHint') }}</div>
        <div v-if="autoGainReferenceFeedback" class="mixtape-auto-gain-dialog__feedback">
          {{ autoGainReferenceFeedback }}
        </div>
        <div class="mixtape-auto-gain-dialog__song-list-host">
          <OverlayScrollbarsComponent
            ref="autoGainSongListScrollRef"
            class="mixtape-auto-gain-dialog__songs-scroll"
            :options="{
              scrollbars: {
                autoHide: 'leave' as const,
                autoHideDelay: 50,
                clickScroll: true
              } as const,
              overflow: {
                x: 'scroll',
                y: 'scroll'
              } as const
            }"
            element="div"
            defer
          >
            <SongListHeader
              :columns="autoGainDialogColumns"
              :t="autoGainHeaderTranslate"
              :ascending-order="ascendingOrder"
              :descending-order="descendingOrder"
              :total-width="autoGainSongTotalWidth"
              @update:columns="handleAutoGainColumnsUpdate"
              @column-click="handleAutoGainColumnClick"
              @header-contextmenu="handleAutoGainHeaderContextMenu"
            />
            <div class="mixtape-auto-gain-dialog__song-list">
              <SongListRows
                :songs="autoGainDialogSongs"
                :visible-columns="autoGainSongColumns"
                :selected-song-file-paths="autoGainSelectedRowKeys"
                :total-width="autoGainSongTotalWidth"
                source-library-name="mixtape-auto-gain"
                :source-song-list-u-u-i-d="mixtapePlaylistId"
                :scroll-host-element="autoGainSongListScrollRef?.osInstance()?.elements().viewport"
                song-list-root-dir=""
                @song-click="handleAutoGainSongClick"
                @song-dragstart="handleAutoGainSongDragStart"
              />
            </div>
          </OverlayScrollbarsComponent>
          <ColumnHeaderContextMenu
            v-model="autoGainColumnMenuVisible"
            :target-event="autoGainColumnMenuEvent"
            :columns="autoGainDialogColumns"
            :scroll-host-element="autoGainSongListScrollRef?.osInstance()?.elements().host"
            @toggle-column-visibility="handleAutoGainToggleColumnVisibility"
          />
        </div>
        <div class="mixtape-auto-gain-dialog__actions">
          <button
            type="button"
            :disabled="autoGainBusy || autoGainDialogSongs.length < 2"
            @click="handleAutoGainSelectLoudestReferenceClick"
          >
            {{ t('mixtape.autoGainSelectLoudestAction') }}
          </button>
          <button
            type="button"
            :disabled="autoGainBusy || autoGainDialogSongs.length < 2"
            @click="handleAutoGainSelectQuietestReferenceClick"
          >
            {{ t('mixtape.autoGainSelectQuietestAction') }}
          </button>
          <button type="button" :disabled="autoGainBusy" @click="handleAutoGainDialogCancelClick">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="autoGainBusy || !autoGainReferenceTrackId"
            @click="handleAutoGainDialogConfirmClick"
          >
            {{ t('common.confirm') }}
          </button>
        </div>
        <div v-if="autoGainBusy" class="mixtape-auto-gain-dialog__busy-mask">
          <div class="bpm-loading-card">
            <div class="bpm-loading-title">{{ t('mixtape.autoGainRunning') }}</div>
            <div class="bpm-loading-sub">{{ autoGainProgressText }}</div>
          </div>
        </div>
      </div>
    </div>
    <MixtapeOutputDialog
      v-if="outputDialogVisible"
      :output-path="outputPath"
      :output-format="outputFormat"
      :output-filename="outputFilename"
      @confirm="handleOutputDialogConfirm"
      @cancel="handleOutputDialogCancel"
    />
    <div
      v-if="trackContextMenuVisible"
      class="mixtape-track-menu"
      :style="trackContextMenuStyle"
      @contextmenu.stop.prevent
    >
      <button class="mixtape-track-menu__item" type="button" @click="handleTrackMenuAdjustGrid">
        {{ t('mixtape.adjustGridMenu') }}
      </button>
      <button
        class="mixtape-track-menu__item"
        type="button"
        @click="handleTrackMenuToggleMasterTempo"
      >
        <span class="mixtape-track-menu__check">{{ trackMenuMasterTempoChecked ? '✓' : '' }}</span>
        <span>{{ t('mixtape.masterTempoMenu') }}</span>
      </button>
    </div>
    <MixtapeBeatAlignDialog
      v-if="beatAlignDialogVisible && beatAlignTrack"
      :track-title="resolveTrackTitle(beatAlignTrack)"
      :track-key="beatAlignTrack.key"
      :file-path="beatAlignTrack.filePath"
      :bpm="
        Number(beatAlignTrack.gridBaseBpm) ||
        Number(beatAlignTrack.originalBpm) ||
        Number(beatAlignTrack.bpm) ||
        128
      "
      :first-beat-ms="Number(beatAlignTrack.firstBeatMs) || 0"
      :bar-beat-offset="Number(beatAlignTrack.barBeatOffset) || 0"
      @save-grid-definition="handleBeatAlignGridDefinitionSave"
      @cancel="handleBeatAlignDialogCancel"
    />
  </div>
</template>

<style scoped lang="scss" src="./Mixtape.scss"></style>
