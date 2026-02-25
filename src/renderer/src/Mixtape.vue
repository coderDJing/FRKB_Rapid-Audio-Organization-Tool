<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import MixtapeOutputDialog from '@renderer/components/mixtapeOutputDialog.vue'
import MixtapeBeatAlignDialog from '@renderer/components/mixtapeBeatAlignDialog.vue'
import ColumnHeaderContextMenu from '@renderer/pages/modules/songsArea/ColumnHeaderContextMenu.vue'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import {
  buildSongsAreaDefaultColumns,
  getSongsAreaMinWidthByKey,
  SONGS_AREA_MIXTAPE_STORAGE_KEY
} from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { mapMixtapeSnapshotToSongInfo } from '@renderer/composables/mixtape/mixtapeSnapshotSongMapper'
import { useMixtape } from '@renderer/composables/useMixtape'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { applyUiSettings, readUiSettings } from '@renderer/utils/uiSettingsStorage'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { createMixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildMixEnvelopePolylineByControlPoints,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import type {
  MixtapeEnvelopeParamId,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import type { ISongInfo, ISongsAreaColumn } from '../../types/globals'

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
  rulerPlayheadStyle,
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

type TrackEnvelopePreviewLine = {
  key: MixtapeEnvelopeParamId
  points: string
  color: string
  strokeWidth: number
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

const TRACK_ENVELOPE_PREVIEW_PARAMS: MixtapeEnvelopeParamId[] = [
  'gain',
  'high',
  'mid',
  'low',
  'volume'
]

const TRACK_ENVELOPE_PREVIEW_COLORS: Record<MixtapeEnvelopeParamId, string> = {
  gain: '#f2f6ff',
  high: '#4f8bff',
  mid: '#45d07e',
  low: '#ff5d61',
  volume: '#ffc94a'
}

const TRACK_ENVELOPE_PREVIEW_STROKES: Record<MixtapeEnvelopeParamId, number> = {
  gain: 1.2,
  high: 1.08,
  mid: 1.08,
  low: 1.08,
  volume: 0.95
}

const TIMELINE_TRACK_LANE_GAP_PX = 8
const TIMELINE_TRACK_VERTICAL_PADDING_PX = 10
const TIMELINE_TRACK_LANE_BORDER_PX = 2

const trackEnvelopePreviewLegend = TRACK_ENVELOPE_PREVIEW_PARAMS.map((param) => ({
  key: param,
  label: param.toUpperCase(),
  color: TRACK_ENVELOPE_PREVIEW_COLORS[param]
}))

const timelineTrackAreaHeight = computed(() => {
  const laneCount = Math.max(0, Array.isArray(laneIndices) ? laneIndices.length : 0)
  const rawLaneHeight =
    (laneHeight as unknown as { value?: number } | null)?.value ?? (laneHeight as unknown as number)
  const safeLaneHeight = Math.max(0, Number(rawLaneHeight) || 0)
  if (!laneCount || !safeLaneHeight) return 0
  const laneOuterHeight = safeLaneHeight + TIMELINE_TRACK_LANE_BORDER_PX
  const gaps = Math.max(0, laneCount - 1) * TIMELINE_TRACK_LANE_GAP_PX
  const verticalPadding = TIMELINE_TRACK_VERTICAL_PADDING_PX * 2
  return Math.round(laneOuterHeight * laneCount + gaps + verticalPadding)
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
const runtime = useRuntimeStore()
useWaveformPreviewPlayer()
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const autoGainHeaderTranslate = (key: string) => t(key)

const autoGainSongListScrollRef = ref<OverlayScrollbarsComponentRef>(null)
const autoGainColumnMenuVisible = ref(false)
const autoGainColumnMenuEvent = ref<MouseEvent | null>(null)

const MIXTAPE_COLUMN_MODE = 'mixtape' as const

const normalizeColumnOrder = (_value: unknown): undefined => undefined

const persistAutoGainColumns = (columns: ISongsAreaColumn[]) => {
  try {
    const normalized = columns.map((column) => ({
      ...column,
      order: normalizeColumnOrder(column.order)
    }))
    localStorage.setItem(SONGS_AREA_MIXTAPE_STORAGE_KEY, JSON.stringify(normalized))
  } catch {}
}

const loadAutoGainColumns = () => {
  const defaultColumns: ISongsAreaColumn[] = buildSongsAreaDefaultColumns(MIXTAPE_COLUMN_MODE).map(
    (column) => ({
      ...column,
      order: normalizeColumnOrder(column.order)
    })
  )
  const defaultColumnsByKey = new Map(defaultColumns.map((column) => [column.key, column]))
  const saved = localStorage.getItem(SONGS_AREA_MIXTAPE_STORAGE_KEY)
  let mergedColumns: ISongsAreaColumn[] = defaultColumns
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<ISongsAreaColumn>[]
      const normalized: ISongsAreaColumn[] = parsed
        .map((item): ISongsAreaColumn | null => {
          const key = String(item?.key || '')
          const fallback = defaultColumnsByKey.get(key)
          if (!fallback) return null
          const minWidth = getSongsAreaMinWidthByKey(fallback.key, MIXTAPE_COLUMN_MODE)
          const rawWidth = Number(item?.width)
          const nextColumn: ISongsAreaColumn = {
            ...fallback,
            show: typeof item?.show === 'boolean' ? item.show : fallback.show,
            width: Number.isFinite(rawWidth) ? Math.max(minWidth, rawWidth) : fallback.width
          }
          nextColumn.order = normalizeColumnOrder(item?.order)
          return nextColumn
        })
        .filter((item): item is ISongsAreaColumn => item !== null)
      if (normalized.length) {
        const existingKeySet = new Set(normalized.map((item) => item.key))
        for (const fallback of defaultColumns) {
          if (existingKeySet.has(fallback.key)) continue
          normalized.push(fallback)
        }
        mergedColumns = normalized
      }
    } catch {}
  }
  const visibleColumns = mergedColumns.filter((column) => column.show)
  return visibleColumns.length ? mergedColumns : defaultColumns
}

const autoGainDialogColumns = ref<ISongsAreaColumn[]>(loadAutoGainColumns())

watch(
  () => autoGainDialogColumns.value,
  (columns) => {
    persistAutoGainColumns(columns)
  },
  { deep: true }
)

const autoGainSongColumns = computed<ISongsAreaColumn[]>(() =>
  autoGainDialogColumns.value.filter((column) => column.show)
)

const autoGainSongTotalWidth = computed(() =>
  autoGainSongColumns.value.reduce((sum, column) => sum + Number(column.width || 0), 0)
)

const autoGainDialogSongs = computed<ISongInfo[]>(() => {
  return mixtapeRawItems.value.map((raw, index) =>
    mapMixtapeSnapshotToSongInfo(raw, index, {
      buildDisplayPathByUuid: (uuid) => libraryUtils.buildDisplayPathByUuid(uuid)
    })
  )
})

const autoGainSelectedRowKeys = computed(() => {
  const referenceTrackId = autoGainReferenceTrackId.value
  if (!referenceTrackId) return []
  const targetTrack = tracks.value.find((item) => item.id === referenceTrackId)
  const keys = [referenceTrackId, targetTrack?.filePath || ''].filter(Boolean)
  return Array.from(new Set(keys))
})

const resolveAutoGainReferenceId = (song: ISongInfo) => {
  if (song.mixtapeItemId) return song.mixtapeItemId
  const matchedTrack = tracks.value.find((item) => item.filePath === song.filePath)
  return matchedTrack?.id || ''
}

const handleAutoGainSongClick = (_event: MouseEvent, song: ISongInfo) => {
  const nextId = resolveAutoGainReferenceId(song)
  if (nextId) autoGainReferenceTrackId.value = nextId
}

const handleAutoGainSongDragStart = (event: DragEvent) => {
  event.preventDefault()
}

const handleAutoGainColumnsUpdate = (columns: ISongsAreaColumn[]) => {
  if (!Array.isArray(columns) || !columns.length) return
  autoGainDialogColumns.value = columns.map((column) => ({
    ...column,
    order: normalizeColumnOrder(column.order)
  }))
}

const handleAutoGainColumnClick = (_column: ISongsAreaColumn) => {
  // 与主窗口混音歌单一致：列头点击不触发排序
}

const handleAutoGainHeaderContextMenu = (event: MouseEvent) => {
  autoGainColumnMenuEvent.value = event
  autoGainColumnMenuVisible.value = true
}

const handleAutoGainToggleColumnVisibility = (columnKey: string) => {
  const key = String(columnKey || '')
  if (!key) return
  autoGainDialogColumns.value = autoGainDialogColumns.value.map((column) =>
    column.key === key ? { ...column, show: !column.show } : column
  )
}

const refreshRuntimeSetting = async () => {
  try {
    const latest = await window.electron.ipcRenderer.invoke('getSetting')
    if (latest && typeof latest === 'object') {
      const merged = { ...(latest as Record<string, unknown>) }
      applyUiSettings(merged, readUiSettings())
      runtime.setting = merged as any
    }
  } catch {}
}

const handleOpenAutoGainDialog = async () => {
  await refreshRuntimeSetting()
  autoGainDialogColumns.value = loadAutoGainColumns()
  autoGainColumnMenuVisible.value = false
  autoGainColumnMenuEvent.value = null
  openAutoGainDialog()
}

const stopAutoGainWaveformPreview = () => {
  emitter.emit('waveform-preview:stop', { reason: 'explicit' })
}

const handleAutoGainDialogCancelClick = () => {
  stopAutoGainWaveformPreview()
  handleAutoGainDialogCancel()
}

const handleAutoGainDialogConfirmClick = async () => {
  stopAutoGainWaveformPreview()
  await handleAutoGainDialogConfirm()
}

const handleAutoGainSelectLoudestReferenceClick = async () => {
  stopAutoGainWaveformPreview()
  await handleAutoGainSelectLoudestReference()
}

const handleAutoGainSelectQuietestReferenceClick = async () => {
  stopAutoGainWaveformPreview()
  await handleAutoGainSelectQuietestReference()
}

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

const resolveTrackEnvelopePreviewLines = (
  item: TimelineTrackLayout
): TrackEnvelopePreviewLine[] => {
  const currentTrack = tracks.value.find((track) => track.id === item.track.id) || item.track
  const durationSec = Math.max(0, Number(resolveTrackDurationSeconds(currentTrack)) || 0)
  if (!durationSec) return []
  return TRACK_ENVELOPE_PREVIEW_PARAMS.map((param) => {
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const normalizedPoints = normalizeMixEnvelopePoints(
      param,
      (currentTrack as Record<string, unknown>)[envelopeField],
      durationSec
    )
    if (normalizedPoints.length < 2) return null
    const points = buildMixEnvelopePolylineByControlPoints({
      param,
      points: normalizedPoints,
      durationSec
    })
    if (!points) return null
    return {
      key: param,
      points,
      color: TRACK_ENVELOPE_PREVIEW_COLORS[param],
      strokeWidth: TRACK_ENVELOPE_PREVIEW_STROKES[param]
    }
  }).filter((line): line is TrackEnvelopePreviewLine => line !== null)
}

const trackEnvelopePreviewViewportStyle = computed(() => {
  const safeWidth = Math.max(0, Number(timelineContentWidth.value) || 0)
  const safeScrollLeft = Math.max(0, Number(timelineScrollLeft.value) || 0)
  return {
    width: `${safeWidth}px`,
    transform: `translate3d(${-safeScrollLeft}px, 0, 0)`
  }
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
          <section class="timeline">
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
              <div class="timeline-ruler" @mousedown="handleRulerSeek">
                <div class="timeline-ruler__ticks">
                  <div
                    v-for="tick in rulerMinuteTicks"
                    :key="`minute-${tick.value}-${tick.left}`"
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
                      {{ tick.value }}
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
                <div
                  v-if="playheadVisible"
                  class="timeline-ruler__playhead"
                  :style="rulerPlayheadStyle"
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
                      <div v-for="laneIndex in laneIndices" :key="laneIndex" class="timeline-lane">
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
                                'is-segment-mute-mode': isVolumeParamMode && volumeMuteSelectionMode
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
                  <div
                    v-if="playheadVisible && timelinePlayheadStyle"
                    class="timeline-playhead"
                    :style="timelinePlayheadStyle"
                  ></div>
                </div>
              </OverlayScrollbarsComponent>
              <canvas ref="timelineCanvasRef" class="timeline-waveform-canvas"></canvas>
              <div v-if="preRenderState.active" class="timeline-preload">
                <div class="preload-card">
                  <div class="preload-title">
                    {{ t('mixtape.waveformPreparing') }} {{ preRenderPercent }}%
                  </div>
                  <div class="preload-bar">
                    <div class="preload-bar__fill" :style="{ width: `${preRenderPercent}%` }"></div>
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
                  v-if="playheadVisible"
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
