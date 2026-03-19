<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import MixtapeDialogsLayer from '@renderer/components/MixtapeDialogsLayer.vue'
import MixtapeEnvelopePreviewTrack from '@renderer/components/mixtape/MixtapeEnvelopePreviewTrack.vue'
import MixtapeGlobalBpmEditor from '@renderer/components/mixtape/MixtapeGlobalBpmEditor.vue'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useMixtape } from '@renderer/composables/useMixtape'
import { createMixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import { useMixtapeAutoGainDialog } from '@renderer/composables/mixtape/useMixtapeAutoGainDialog'
import { useMixtapeEnvelopePreview } from '@renderer/composables/mixtape/useMixtapeEnvelopePreview'
import {
  buildTrackTimingUndoSnapshot,
  isTrackTimingSnapshotSame,
  restoreTrackTimingUndoSnapshot
} from '@renderer/composables/mixtape/mixtapeTrackTimingUndo'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import type {
  MixtapeEnvelopeParamId,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import type { TrackTimingUndoSnapshot } from '@renderer/composables/mixtape/mixtapeTrackTimingUndo'

const {
  t,
  titleLabel,
  mixtapePlaylistId,
  mixtapeMenus,
  handleTitleOpenDialog,
  mixtapeRawItems,
  mixtapeItemsLoading,
  mixtapeMixMode,
  mixtapeStemMode,
  tracks,
  clearTimelineLayoutCache,
  updateTimelineWidth,
  scheduleTimelineDraw,
  scheduleFullPreRender,
  scheduleWorkerPreRender,
  laneIndices,
  laneHeight,
  laneTracks,
  renderZoomLevel,
  resolveTrackDurationSeconds,
  resolveTrackSourceDurationSeconds,
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
  handleTrackMenuRemoveFromMixtape,
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
  playheadSec,
  followPlayheadEnabled,
  playheadTimeLabel,
  timelineDurationLabel,
  rulerMinuteTicks,
  rulerInactiveStyle,
  overviewPlayheadStyle,
  timelinePlayheadStyle,
  handleTransportPlayFromStart,
  handleTransportStop,
  handleRulerSeek,
  handleToggleFollowPlayhead,
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
  bpmAnalysisFailedReason,
  dismissBpmAnalysisFailure,
  retryBpmAnalysis,
  outputDialogVisible,
  outputPath,
  outputFormat,
  outputFilename,
  outputRunning,
  outputProgressText,
  outputProgressPercent,
  stemRuntimeDownloadVisible,
  stemRuntimeDownloadPercent,
  stemRuntimeDownloadTitle,
  stemRuntimeDownloadText,
  handleOutputDialogConfirm,
  handleOutputDialogCancel,
  stemSeparationProgressVisible,
  stemSeparationProgressPercent,
  stemSeparationProgressText,
  stemSeparationRunningProgressLines,
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

type MixParamId =
  | 'position'
  | 'gain'
  | 'high'
  | 'mid'
  | 'low'
  | 'vocal'
  | 'inst'
  | 'bass'
  | 'drums'
  | 'volume'
type MixParamOption = {
  id: MixParamId
  labelKey: string
}

const STEM_PARAM_SET = new Set<MixParamId>(['vocal', 'inst', 'bass', 'drums'])
const isStemMixMode = computed(() => mixtapeMixMode.value === 'stem')

const mixParamOptions = computed<MixParamOption[]>(() => {
  if (!isStemMixMode.value) {
    return [
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
    ]
  }

  const options: MixParamOption[] = [
    {
      id: 'position',
      labelKey: 'mixtape.mixParamPosition'
    },
    {
      id: 'gain',
      labelKey: 'mixtape.mixParamGain'
    },
    {
      id: 'vocal',
      labelKey: 'mixtape.mixParamVocal'
    },
    {
      id: 'inst',
      labelKey: 'mixtape.mixParamInst'
    }
  ]
  options.push(
    {
      id: 'bass',
      labelKey: 'mixtape.mixParamBass'
    },
    {
      id: 'drums',
      labelKey: 'mixtape.mixParamDrums'
    },
    {
      id: 'volume',
      labelKey: 'mixtape.mixParamVolume'
    }
  )
  return options
})

const selectedMixParam = ref<MixParamId>('position')
const isTrackPositionMode = computed(() => selectedMixParam.value === 'position')
const isGainParamMode = computed(() => selectedMixParam.value === 'gain')
const isVolumeParamMode = computed(() => selectedMixParam.value === 'volume')
const isStemParamMode = computed(() => STEM_PARAM_SET.has(selectedMixParam.value))
const isEnvelopeParamMode = computed(() => !isTrackPositionMode.value)
const showTrackEnvelopeEditor = computed(() => isEnvelopeParamMode.value)
const isSegmentSelectionSupported = computed(() => isVolumeParamMode.value || isStemParamMode.value)
const segmentSelectionMode = ref(false)
const isSegmentSelectionActive = computed(
  () => isStemParamMode.value || (isSegmentSelectionSupported.value && segmentSelectionMode.value)
)
const showEnvelopeCurve = computed(() => isEnvelopeParamMode.value && !isStemParamMode.value)
const envelopePreviewLineKeys = computed<MixtapeEnvelopeParamId[]>(() =>
  isStemMixMode.value ? ['gain', 'volume'] : ['gain', 'high', 'mid', 'low', 'volume']
)
const envelopeHintKey = computed(() => {
  if (isSegmentSelectionActive.value) {
    return 'mixtape.segmentMuteHint'
  }
  if (isStemParamMode.value) {
    return 'mixtape.stemSegmentHint'
  }
  return 'mixtape.envelopeEditHint'
})

const {
  trackEnvelopePreviewLegend,
  timelineTrackAreaHeight,
  timelineAdaptiveStyle,
  resolveTrackEnvelopePreviewLines,
  resolveTrackStemPreviewRows,
  trackEnvelopePreviewViewportStyle
} = useMixtapeEnvelopePreview({
  laneIndices,
  laneHeight,
  renderZoomLevel,
  showStemPreviewRows: isStemMixMode,
  previewParams: envelopePreviewLineKeys,
  timelineVisualScale,
  timelineContentWidth,
  timelineScrollLeft,
  tracks,
  resolveTrackDurationSeconds,
  resolveTrackFirstBeatSeconds,
  resolveTrackSourceDurationSeconds
})

watch(selectedMixParam, (nextParam) => {
  if (nextParam === 'position' || nextParam === 'gain') {
    segmentSelectionMode.value = false
    return
  }
  if (STEM_PARAM_SET.has(nextParam)) {
    segmentSelectionMode.value = true
  }
})

watch(mixParamOptions, (nextOptions) => {
  const availableIds = new Set(nextOptions.map((option) => option.id))
  if (!availableIds.has(selectedMixParam.value)) {
    selectedMixParam.value = 'position'
  }
})

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
      pushExternalUndoStep(() => restoreTrackTimingUndoSnapshot(tracks, beforeSnapshot))
    },
    { once: true }
  )
}
useWaveformPreviewPlayer()
const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const autoGainHeaderTranslate = (key: string) => t(key)
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

const handleToggleSegmentSelectionMode = () => {
  if (!isSegmentSelectionSupported.value) return
  if (isStemParamMode.value) {
    segmentSelectionMode.value = true
    return
  }
  segmentSelectionMode.value = !segmentSelectionMode.value
}

const envelopeEditable = computed(() => isEnvelopeParamMode.value)
const {
  resolveActiveEnvelopePolyline,
  resolveActiveEnvelopePointDots,
  resolveActiveSegmentMasks,
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
  resolveTrackSourceDurationSeconds,
  resolveTrackFirstBeatSeconds,
  resolveActiveParam: () =>
    isEnvelopeParamMode.value ? (selectedMixParam.value as MixtapeEnvelopeParamId) : null,
  isSegmentSelectionMode: () => isSegmentSelectionActive.value,
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

const resolveEnvelopePointBoundaryClass = (point: unknown) => {
  const candidate = point as { x?: number }
  const x = Number(candidate.x)
  if (!Number.isFinite(x)) return ''
  if (x <= 0.001) return 'is-boundary-start'
  if (x >= 99.999) return 'is-boundary-end'
  return ''
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

const MASTER_TEMPO_LANE_BASE_HEIGHT = 84
const MASTER_TEMPO_LANE_MIN_HEIGHT = 68

const masterTempoLaneHeight = computed(() => {
  if (!tracks.value.length) return 0
  const scale = Math.min(1, Math.max(0.5, Number(timelineVisualScale.value) || 1))
  return Math.max(MASTER_TEMPO_LANE_MIN_HEIGHT, Math.round(MASTER_TEMPO_LANE_BASE_HEIGHT * scale))
})

const timelineTrackAreaStyle = computed(() => ({
  height: `${timelineTrackAreaHeight.value + masterTempoLaneHeight.value}px`
}))

const handleGlobalBpmTrackTargetsSync = (nextTracks: MixtapeTrack[]) => {
  tracks.value = nextTracks
}
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
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              :class="{ 'is-active': followPlayheadEnabled }"
              type="button"
              :title="
                followPlayheadEnabled
                  ? t('mixtape.followPlayheadActionHintDisable')
                  : t('mixtape.followPlayheadActionHintEnable')
              "
              :aria-label="
                followPlayheadEnabled
                  ? t('mixtape.followPlayheadActionHintDisable')
                  : t('mixtape.followPlayheadActionHintEnable')
              "
              @click="handleToggleFollowPlayhead"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="3" y="3" width="10" height="10" rx="1.4"></rect>
                <path d="M8 2v12"></path>
                <path d="M5.9 5.4 8 3.3l2.1 2.1"></path>
                <path d="M5.9 10.6 8 12.7l2.1-2.1"></path>
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
              v-if="isSegmentSelectionSupported"
              class="button mixtape-param-bar__action-btn"
              :class="{ 'is-active': isSegmentSelectionActive }"
              type="button"
              @click="handleToggleSegmentSelectionMode"
            >
              {{ t(isVolumeParamMode ? 'mixtape.segmentMuteAction' : 'mixtape.stemSegmentAction') }}
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
                :style="timelineTrackAreaStyle"
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
                    <MixtapeGlobalBpmEditor
                      :visible="tracks.length > 0"
                      :playlist-id="mixtapePlaylistId"
                      :tracks="tracks"
                      :height-px="masterTempoLaneHeight"
                      :render-zoom-level="renderZoomLevel"
                      :timeline-scroll-left="timelineScrollLeft"
                      :timeline-viewport-width="timelineViewportWidth"
                      :playhead-sec="playheadSec"
                      :playhead-visible="playheadVisible"
                      :timeline-content-width="timelineContentWidth"
                      :resolve-track-duration-seconds="resolveTrackDurationSeconds"
                      :resolve-track-source-duration-seconds="resolveTrackSourceDurationSeconds"
                      :push-external-undo-step="pushExternalUndoStep"
                      :on-tracks-sync="handleGlobalBpmTrackTargetsSync"
                      :on-envelope-preview-changed="
                        () => {
                          clearTimelineLayoutCache()
                          updateTimelineWidth(false)
                          scheduleTimelineDraw()
                        }
                      "
                      :on-envelope-committed="
                        () => {
                          clearTimelineLayoutCache()
                          updateTimelineWidth(false)
                          scheduleTimelineDraw()
                          scheduleFullPreRender()
                          scheduleWorkerPreRender()
                        }
                      "
                    />
                    <div class="timeline-lanes">
                      <div v-if="tracks.length === 0" class="timeline-empty">
                        <div>
                          {{ mixtapeItemsLoading ? t('mixtape.loading') : t('mixtape.trackEmpty') }}
                        </div>
                        <div v-if="!mixtapeItemsLoading" class="timeline-empty-hint">
                          {{ t('mixtape.trackEmptyHint') }}
                        </div>
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
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  x1="0"
                                  y1="50"
                                  x2="100"
                                  y2="50"
                                ></line>
                                <polyline
                                  class="lane-track__envelope-line"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolyline(item)"
                                ></polyline>
                              </svg>
                              <div class="lane-track__mute-segments">
                                <div
                                  v-for="segment in resolveActiveSegmentMasks(item)"
                                  :key="`mute-${item.track.id}-${segment.key}`"
                                  class="lane-track__mute-segment"
                                  :style="{
                                    left: `${segment.left}%`,
                                    width: `${segment.width}%`
                                  }"
                                ></div>
                              </div>
                              <div
                                v-if="showTrackEnvelopeEditor"
                                class="lane-track__envelope-points"
                                :class="{
                                  'is-segment-mute-mode': isSegmentSelectionActive
                                }"
                                @mousedown.stop.prevent="handleEnvelopeStageMouseDown(item, $event)"
                              >
                                <template
                                  v-if="
                                    showEnvelopeCurve &&
                                    !(isVolumeParamMode && isSegmentSelectionActive)
                                  "
                                >
                                  <button
                                    v-for="point in resolveActiveEnvelopePointDots(item)"
                                    :key="`point-${item.track.id}-${point.index}`"
                                    class="lane-track__envelope-point"
                                    :class="[
                                      { 'is-boundary': point.isBoundary },
                                      resolveEnvelopePointBoundaryClass(point)
                                    ]"
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
                                </template>
                              </div>
                              <div v-if="isTrackPositionMode" class="lane-track__meta">
                                <div class="lane-track__meta-title">
                                  {{ item.track.mixOrder }}.
                                  {{ resolveTrackTitleWithOriginalMeta(item.track) }}
                                </div>
                                <div class="lane-track__meta-sub">
                                  {{ t('mixtape.bpm') }} {{ formatTrackBpm(item.track.bpm) }}
                                  <template v-if="formatTrackKey(item.track.key)">
                                    | {{ t('columns.key') }} {{ formatTrackKey(item.track.key) }}
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
                    :style="{ color: legend.color }"
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
                  <div
                    v-if="tracks.length === 0"
                    class="timeline-envelope-preview__empty"
                    :class="{ 'is-loading': mixtapeItemsLoading }"
                  >
                    {{ mixtapeItemsLoading ? t('mixtape.loading') : t('mixtape.trackEmptyHint') }}
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
                        <MixtapeEnvelopePreviewTrack
                          v-for="item in laneTracks[laneIndex]"
                          :key="`envelope-preview-${item.track.id}`"
                          :item="item"
                          :track-style="resolveTrackBlockStyle(item)"
                          :lines="resolveTrackEnvelopePreviewLines(item)"
                          :stem-rows="resolveTrackStemPreviewRows(item)"
                          :mute-segments="resolveActiveSegmentMasks(item)"
                          :show-stem-rows="isStemMixMode"
                          :show-mute-segments="!isStemMixMode || isVolumeParamMode"
                        />
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
    <MixtapeDialogsLayer
      :t="t"
      :transport-preloading="transportPreloading"
      :transport-preload-done="transportPreloadDone"
      :transport-preload-total="transportPreloadTotal"
      :transport-preload-percent="transportPreloadPercent"
      :stem-separation-progress-visible="stemSeparationProgressVisible"
      :stem-separation-progress-percent="stemSeparationProgressPercent"
      :stem-separation-progress-text="stemSeparationProgressText"
      :stem-separation-running-progress-lines="stemSeparationRunningProgressLines"
      :bpm-analysis-active="bpmAnalysisActive"
      :bpm-analysis-failed="bpmAnalysisFailed"
      :bpm-analysis-failed-count="bpmAnalysisFailedCount"
      :bpm-analysis-failed-reason="bpmAnalysisFailedReason"
      :retry-bpm-analysis="retryBpmAnalysis"
      :dismiss-bpm-analysis-failure="dismissBpmAnalysisFailure"
      :auto-gain-busy="autoGainBusy"
      :auto-gain-dialog-visible="autoGainDialogVisible"
      :auto-gain-progress-text="autoGainProgressText"
      :output-running="outputRunning"
      :output-progress-text="outputProgressText"
      :output-progress-percent="outputProgressPercent"
      :stem-runtime-download-visible="stemRuntimeDownloadVisible"
      :stem-runtime-download-percent="stemRuntimeDownloadPercent"
      :stem-runtime-download-title="stemRuntimeDownloadTitle"
      :stem-runtime-download-text="stemRuntimeDownloadText"
      :auto-gain-reference-feedback="autoGainReferenceFeedback"
      :auto-gain-dialog-columns="autoGainDialogColumns"
      :auto-gain-song-columns="autoGainSongColumns"
      :auto-gain-song-total-width="autoGainSongTotalWidth"
      :auto-gain-dialog-songs="autoGainDialogSongs"
      :auto-gain-selected-row-keys="autoGainSelectedRowKeys"
      :auto-gain-column-menu-visible="autoGainColumnMenuVisible"
      @update:auto-gain-column-menu-visible="autoGainColumnMenuVisible = $event"
      :auto-gain-column-menu-event="autoGainColumnMenuEvent"
      :auto-gain-header-translate="autoGainHeaderTranslate"
      :ascending-order="ascendingOrder"
      :descending-order="descendingOrder"
      :mixtape-playlist-id="mixtapePlaylistId"
      :handle-auto-gain-columns-update="handleAutoGainColumnsUpdate"
      :handle-auto-gain-column-click="handleAutoGainColumnClick"
      :handle-auto-gain-header-context-menu="handleAutoGainHeaderContextMenu"
      :handle-auto-gain-toggle-column-visibility="handleAutoGainToggleColumnVisibility"
      :handle-auto-gain-song-click="handleAutoGainSongClick"
      :handle-auto-gain-song-drag-start="handleAutoGainSongDragStart"
      :handle-auto-gain-select-loudest-reference-click="handleAutoGainSelectLoudestReferenceClick"
      :handle-auto-gain-select-quietest-reference-click="handleAutoGainSelectQuietestReferenceClick"
      :handle-auto-gain-dialog-cancel-click="handleAutoGainDialogCancelClick"
      :handle-auto-gain-dialog-confirm-click="handleAutoGainDialogConfirmClick"
      :auto-gain-reference-track-id="autoGainReferenceTrackId"
      :output-dialog-visible="outputDialogVisible"
      :output-path="outputPath"
      :output-format="outputFormat"
      :output-filename="outputFilename"
      :handle-output-dialog-confirm="handleOutputDialogConfirm"
      :handle-output-dialog-cancel="handleOutputDialogCancel"
      :track-context-menu-visible="trackContextMenuVisible"
      :track-context-menu-style="trackContextMenuStyle"
      :handle-track-menu-adjust-grid="handleTrackMenuAdjustGrid"
      :handle-track-menu-toggle-master-tempo="handleTrackMenuToggleMasterTempo"
      :handle-track-menu-remove-from-mixtape="handleTrackMenuRemoveFromMixtape"
      :track-menu-master-tempo-checked="trackMenuMasterTempoChecked"
      :beat-align-dialog-visible="beatAlignDialogVisible"
      :beat-align-track="beatAlignTrack"
      :resolve-track-title="resolveTrackTitle"
      :handle-beat-align-grid-definition-save="handleBeatAlignGridDefinitionSave"
      :handle-beat-align-dialog-cancel="handleBeatAlignDialogCancel"
    />
  </div>
</template>

<style scoped lang="scss" src="./Mixtape.scss"></style>
