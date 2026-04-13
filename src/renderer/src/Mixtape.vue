<script setup lang="ts">
import { computed, ref, type CSSProperties } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import WindowVolumeDial from '@renderer/components/WindowVolumeDial.vue'
import MixtapeDialogsLayer from '@renderer/components/MixtapeDialogsLayer.vue'
import MixtapeEnvelopePreviewTrack from '@renderer/components/mixtape/MixtapeEnvelopePreviewTrack.vue'
import MixtapeGlobalBpmEditor from '@renderer/components/mixtape/MixtapeGlobalBpmEditor.vue'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useMixtape } from '@renderer/composables/useMixtape'
import { createMixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import { useMixtapeAutoGainDialog } from '@renderer/composables/mixtape/useMixtapeAutoGainDialog'
import { useMixtapeEnvelopePreview } from '@renderer/composables/mixtape/useMixtapeEnvelopePreview'
import { useMixtapeMixParamUi } from '@renderer/composables/mixtape/useMixtapeMixParamUi'
import { useMixtapeMasterTempoLane } from '@renderer/composables/mixtape/useMixtapeMasterTempoLane'
import { useMixtapeOutputAvailability } from '@renderer/composables/mixtape/useMixtapeOutputAvailability'
import { useMixtapeShellUi } from '@renderer/composables/mixtape/useMixtapeShellUi'
import { useMixtapeStemPlaceholderState } from '@renderer/composables/mixtape/useMixtapeStemPlaceholderState'
import { useMixtapeTrackDragUndo } from '@renderer/composables/mixtape/useMixtapeTrackDragUndo'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import type {
  MixtapeEnvelopeParamId,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import {
  MIXTAPE_WINDOW_VOLUME_STORAGE_KEY,
  readWindowVolume,
  writeWindowVolume
} from '@renderer/utils/windowVolume'

const masterTempoLaneExpanded = ref(false)

const {
  t,
  titleLabel,
  mixtapePlaylistId,
  handleTitleOpenDialog,
  mixtapeRawItems,
  mixtapeItemsLoading,
  mixtapeMixMode,
  mixtapeStemMode,
  mixtapeStemProfile,
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
  stemRetryingTrackIdMap,
  stemRuntimeProgressByTrackId,
  handleOutputDialogConfirm,
  handleOutputDialogCancel,
  stemSeparationProgressVisible,
  stemSeparationProgressPercent,
  stemSeparationProgressText,
  stemSeparationRunningProgressLines,
  handleRetryTrackStem,
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
  handleAutoGainSelectQuietestReference,
  setTransportMasterVolume,
  setZoomValue,
  applyRenderZoomImmediate
} = useMixtape({
  layoutScaleDeps: [masterTempoLaneExpanded]
})

const mixtapeWindowVolume = ref(readWindowVolume(MIXTAPE_WINDOW_VOLUME_STORAGE_KEY))
setTransportMasterVolume(mixtapeWindowVolume.value)

const handleMixtapeWindowVolumeChange = (value: number) => {
  const nextVolume = writeWindowVolume(MIXTAPE_WINDOW_VOLUME_STORAGE_KEY, value)
  mixtapeWindowVolume.value = nextVolume
  setTransportMasterVolume(nextVolume)
}

const { canOutput: canOutputFromTitle } = useMixtapeOutputAvailability({
  tracks,
  mixtapeItemsLoading,
  mixtapeMixMode,
  mixtapeStemProfile,
  bpmAnalysisActive,
  transportDecoding,
  transportPreloading,
  outputRunning,
  resolveTrackSourceDurationSeconds
})

const titleMenus = computed(() => [
  {
    name: 'mixtape.menuOutput',
    subMenu: [],
    directAction: 'mixtape.menuOutput',
    disabled: !canOutputFromTitle.value
  }
])

const handleTitleMenuOpen = (key: string) => {
  if (key === 'mixtape.menuOutput' && !canOutputFromTitle.value) return
  handleTitleOpenDialog(key)
}

const stemPlaceholderStateByTrackId = useMixtapeStemPlaceholderState({
  mixtapeMixMode,
  tracks,
  stemRetryingTrackIdMap,
  stemRuntimeProgressByTrackId,
  t
})

const {
  envelopeHintKey,
  envelopePreviewLineKeys,
  isEnvelopeParamMode,
  isGainParamMode,
  isSegmentSelectionActive,
  isSegmentSelectionSupported,
  isStemMixMode,
  isStemParamMode,
  isTrackPositionMode,
  isVolumeParamMode,
  handleToggleSegmentSelectionMode,
  mixParamOptions,
  selectedMixParam,
  showEnvelopeCurve,
  showTrackEnvelopeEditor
} = useMixtapeMixParamUi({
  mixtapeMixMode,
  t
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

const {
  handleToggleMasterTempoLane,
  masterTempoEdited,
  masterTempoLaneHeight,
  timelineTrackAreaStyle
} = useMixtapeMasterTempoLane({
  masterTempoLaneExpanded,
  tracks,
  timelineVisualScale,
  timelineTrackAreaHeight,
  mixtapePlaylistId,
  resolveTrackDurationSeconds
})

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

const resolveStemMuteOverlayRows = (item: TimelineTrackLayout) => {
  if (!isStemParamMode.value) return []
  const rows = resolveTrackStemPreviewRows(item)
  const rowCount = rows.length
  if (!rowCount) return []
  const safeLaneHeight = Math.max(1, Math.round(Number(laneHeight.value) || 0))
  return rows.map((row, rowIndex) => {
    const start = Math.floor((safeLaneHeight * rowIndex) / rowCount)
    const end = Math.floor((safeLaneHeight * (rowIndex + 1)) / rowCount)
    const rowHeight = Math.max(1, end - start)
    return {
      key: row.key,
      segments: row.muteSegments,
      isActive: row.key === selectedMixParam.value,
      style: {
        top: `${(start / safeLaneHeight) * 100}%`,
        height: `${(rowHeight / safeLaneHeight) * 100}%`
      } satisfies CSSProperties
    }
  })
}

const {
  resolveActiveEnvelopePolyline,
  resolveActiveEnvelopePolygon,
  resolveActiveGhostPointDot,
  resolveActiveEnvelopePointDots,
  resolveActiveSegmentMasks,
  handleEnvelopeSegmentMouseDown,
  handleEnvelopePointMouseDown,
  handleEnvelopeStageMouseDown,
  handleEnvelopeStageMouseMove,
  handleEnvelopeStageMouseLeave,
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
  isEditable: () => isEnvelopeParamMode.value
})

const trackDragUndoMouseDown = useMixtapeTrackDragUndo({
  tracks,
  handleTrackDragStart,
  pushExternalUndoStep
})

const handleLaneTrackMouseDown = (item: TimelineTrackLayout, event: MouseEvent) => {
  if (!isTrackPositionMode.value) return
  trackDragUndoMouseDown(item, event)
}

const handleUndoMixParam = () => undoLastMixParamChange()
const { handleZoomIn, handleZoomOut, isLightTheme } = useMixtapeShellUi({
  renderZoomLevel,
  setZoomValue,
  applyRenderZoomImmediate,
  canUndoMixParam,
  handleUndoMixParam,
  beatAlignDialogVisible,
  outputDialogVisible,
  autoGainDialogVisible,
  cleanupGainEnvelopeEditor
})

const resolveEnvelopePointBoundaryClass = (point: unknown) => {
  const candidate = point as { x?: number }
  const x = Number(candidate.x)
  if (!Number.isFinite(x)) return ''
  if (x <= 0.001) return 'is-boundary-start'
  if (x >= 99.999) return 'is-boundary-end'
  return ''
}

const handleGlobalBpmTrackTargetsSync = (nextTracks: MixtapeTrack[]) => {
  tracks.value = nextTracks
}
</script>

<template>
  <div
    class="mixtape-shell"
    :class="{ 'is-light-theme': isLightTheme, 'is-dark-theme': !isLightTheme }"
  >
    <div class="mixtape-title-wrap">
      <titleComponent
        control-prefix="mixtapeWindow"
        max-event-channel="mixtapeWindow-max"
        :title-text="titleLabel"
        :menu-override="titleMenus"
        :enable-menu-hotkeys="false"
        @open-dialog="handleTitleMenuOpen"
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
            <button
              class="mixtape-param-bar__tab mixtape-param-bar__tab--bpm"
              :class="{ 'is-active': masterTempoLaneExpanded }"
              type="button"
              :disabled="!tracks.length"
              :aria-pressed="masterTempoLaneExpanded"
              @click="handleToggleMasterTempoLane"
            >
              <span class="mixtape-param-bar__toggle-dot" aria-hidden="true"></span>
              <span class="mixtape-param-bar__toggle-label">{{ t('mixtape.bpm') }}</span>
              <span class="mixtape-param-bar__toggle-state">
                {{
                  t(
                    masterTempoLaneExpanded
                      ? 'mixtape.masterTempoLaneSwitchOn'
                      : 'mixtape.masterTempoLaneSwitchOff'
                  )
                }}
              </span>
            </button>
          </div>
          <div v-if="isEnvelopeParamMode" class="mixtape-param-bar__hint">
            {{ t(envelopeHintKey) }}
          </div>
          <div class="mixtape-param-bar__actions">
            <button
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              type="button"
              :title="t('mixtape.zoomOut')"
              :aria-label="t('mixtape.zoomOut')"
              @click="handleZoomOut"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M4 8h8"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                ></path>
              </svg>
            </button>
            <button
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              type="button"
              :title="t('mixtape.zoomIn')"
              :aria-label="t('mixtape.zoomIn')"
              @click="handleZoomIn"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M8 4v8M4 8h8"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                ></path>
              </svg>
            </button>
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
            <WindowVolumeDial
              class="mixtape-param-bar__volume"
              :model-value="mixtapeWindowVolume"
              :label="t('player.volumeControl')"
              :size="28"
              @update:model-value="handleMixtapeWindowVolumeChange"
            />
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
                    <div v-if="tracks.length > 0" class="timeline-master-bpm-divider">
                      <div class="timeline-master-bpm-divider__inner">
                        <span class="timeline-master-bpm-divider__title">
                          {{ t('mixtape.masterBpm') }}
                        </span>
                        <span v-if="masterTempoEdited" class="timeline-master-bpm-divider__badge">
                          {{ t('mixtape.masterTempoLaneEdited') }}
                        </span>
                      </div>
                    </div>
                    <MixtapeGlobalBpmEditor
                      :visible="tracks.length > 0"
                      :expanded="masterTempoLaneExpanded"
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
                              :class="{
                                'is-stem-pending':
                                  stemPlaceholderStateByTrackId[item.track.id]?.kind === 'pending',
                                'is-stem-running':
                                  stemPlaceholderStateByTrackId[item.track.id]?.kind === 'running',
                                'is-stem-failed':
                                  stemPlaceholderStateByTrackId[item.track.id]?.kind === 'failed'
                              }"
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
                                <polygon
                                  class="lane-track__envelope-fill"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolygon(item)"
                                ></polygon>
                                <polyline
                                  class="lane-track__envelope-line"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolyline(item)"
                                ></polyline>
                                <polyline
                                  class="lane-track__envelope-segment-hit"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolyline(item)"
                                  @mousedown.stop.prevent="
                                    handleEnvelopeSegmentMouseDown(item, $event)
                                  "
                                ></polyline>
                              </svg>
                              <div class="lane-track__mute-segments">
                                <template v-if="isStemParamMode">
                                  <div
                                    v-for="row in resolveStemMuteOverlayRows(item)"
                                    :key="`mute-row-${item.track.id}-${row.key}`"
                                    class="lane-track__stem-mute-row"
                                    :class="{ 'is-active': row.isActive }"
                                    :style="row.style"
                                  >
                                    <div
                                      v-for="segment in row.segments"
                                      :key="`mute-${item.track.id}-${row.key}-${segment.key}`"
                                      class="lane-track__mute-segment"
                                      :style="{
                                        left: `${segment.left}%`,
                                        width: `${segment.width}%`
                                      }"
                                    ></div>
                                  </div>
                                </template>
                                <template v-else>
                                  <div
                                    v-for="segment in resolveActiveSegmentMasks(item)"
                                    :key="`mute-${item.track.id}-${segment.key}`"
                                    class="lane-track__mute-segment"
                                    :style="{
                                      left: `${segment.left}%`,
                                      width: `${segment.width}%`
                                    }"
                                  ></div>
                                </template>
                              </div>
                              <div
                                v-if="showTrackEnvelopeEditor"
                                class="lane-track__envelope-points"
                                :class="{
                                  'is-segment-mute-mode': isSegmentSelectionActive
                                }"
                                @mousedown.stop.prevent="handleEnvelopeStageMouseDown(item, $event)"
                                @mousemove="handleEnvelopeStageMouseMove(item, $event)"
                                @mouseleave="handleEnvelopeStageMouseLeave"
                              >
                                <template
                                  v-if="
                                    showEnvelopeCurve &&
                                    !(isVolumeParamMode && isSegmentSelectionActive)
                                  "
                                >
                                  <div
                                    v-if="resolveActiveGhostPointDot(item)"
                                    class="lane-track__envelope-ghost-point"
                                    :style="{
                                      left: `${resolveActiveGhostPointDot(item)!.x}%`,
                                      top: `${resolveActiveGhostPointDot(item)!.y}%`
                                    }"
                                  ></div>
                                  <div
                                    v-for="point in resolveActiveEnvelopePointDots(item)"
                                    :key="`point-wrap-${item.track.id}-${point.index}`"
                                    class="lane-track__envelope-point-wrap"
                                    :style="{
                                      left: `${point.x}%`,
                                      top: `${point.y}%`
                                    }"
                                  >
                                    <button
                                      class="lane-track__envelope-point"
                                      :class="[
                                        {
                                          'is-boundary': point.isBoundary,
                                          'is-active': point.isActive
                                        },
                                        resolveEnvelopePointBoundaryClass(point)
                                      ]"
                                      type="button"
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
                                    <div
                                      v-if="point.isActive"
                                      class="lane-track__envelope-point-label"
                                      :class="{
                                        'is-above': point.y > 15,
                                        'is-below': point.y <= 15,
                                        'is-align-left': point.x < 5,
                                        'is-align-right': point.x > 95
                                      }"
                                    >
                                      {{ point.gainDb > 0 ? '+' : ''
                                      }}{{ point.gainDb.toFixed(1) }} dB
                                    </div>
                                  </div>
                                </template>
                              </div>
                              <div
                                v-if="stemPlaceholderStateByTrackId[item.track.id]"
                                class="lane-track__stem-placeholder"
                                :class="`is-${stemPlaceholderStateByTrackId[item.track.id].kind}`"
                              >
                                <div class="lane-track__stem-placeholder-top">
                                  <span class="lane-track__stem-placeholder-pill">
                                    {{ stemPlaceholderStateByTrackId[item.track.id].label }}
                                  </span>
                                  <span
                                    v-if="
                                      stemPlaceholderStateByTrackId[item.track.id].percent !== null
                                    "
                                    class="lane-track__stem-placeholder-percent"
                                  >
                                    {{ stemPlaceholderStateByTrackId[item.track.id].percent }}%
                                  </span>
                                </div>
                                <div class="lane-track__stem-placeholder-detail">
                                  {{ stemPlaceholderStateByTrackId[item.track.id].detail }}
                                </div>
                                <div
                                  class="lane-track__stem-placeholder-bar"
                                  :class="{
                                    'is-indeterminate':
                                      stemPlaceholderStateByTrackId[item.track.id].kind ===
                                      'pending'
                                  }"
                                >
                                  <div
                                    class="lane-track__stem-placeholder-fill"
                                    :class="{
                                      'is-indeterminate':
                                        stemPlaceholderStateByTrackId[item.track.id].kind ===
                                        'pending'
                                    }"
                                    :style="
                                      stemPlaceholderStateByTrackId[item.track.id].kind !==
                                      'running'
                                        ? undefined
                                        : {
                                            width: `${stemPlaceholderStateByTrackId[item.track.id].percent}%`
                                          }
                                    "
                                  ></div>
                                </div>
                                <div
                                  v-if="
                                    stemPlaceholderStateByTrackId[item.track.id].kind !== 'failed'
                                  "
                                  class="lane-track__stem-placeholder-skeleton"
                                >
                                  <span class="is-wide"></span>
                                  <span class="is-mid"></span>
                                </div>
                                <div
                                  v-if="
                                    stemPlaceholderStateByTrackId[item.track.id].kind === 'failed'
                                  "
                                  class="lane-track__stem-placeholder-actions"
                                >
                                  <button
                                    class="lane-track__stem-retry-btn"
                                    type="button"
                                    @mousedown.stop.prevent
                                    @click.stop="handleRetryTrackStem(item.track.id)"
                                  >
                                    {{ t('common.retry') }}
                                  </button>
                                </div>
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
