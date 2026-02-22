<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
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
  resolveTrackBlockStyle,
  resolveGainEnvelopePolyline,
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
  timelineScrollRef,
  timelineScrollbarOptions,
  timelineViewport,
  timelineContentWidth,
  timelineScrollLeft,
  timelineViewportWidth,
  timelineCanvasRef,
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

const selectedMixParam = ref<MixParamId>('gain')
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
              :class="{ 'is-active': selectedMixParam === item.id }"
              type="button"
              @click="selectedMixParam = item.id"
            >
              {{ t(item.labelKey) }}
            </button>
          </div>
          <div v-if="selectedMixParam === 'gain'" class="mixtape-param-bar__actions">
            <button
              class="button mixtape-param-bar__action-btn"
              type="button"
              :disabled="!canStartAutoGain"
              @click="handleOpenAutoGainDialog"
            >
              {{ t('mixtape.autoGainAction') }}
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
                            @mousedown.stop="handleTrackDragStart(item, $event)"
                            @contextmenu.stop.prevent="handleTrackContextMenu(item, $event)"
                          >
                            <svg
                              class="lane-track__envelope-svg"
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                            >
                              <line
                                class="lane-track__envelope-midline"
                                :class="{ 'is-hidden': selectedMixParam !== 'gain' }"
                                x1="0"
                                y1="50"
                                x2="100"
                                y2="50"
                              ></line>
                              <polyline
                                class="lane-track__envelope-line"
                                :class="{ 'is-hidden': selectedMixParam !== 'gain' }"
                                :points="resolveGainEnvelopePolyline(item)"
                              ></polyline>
                            </svg>
                            <div class="lane-track__meta">
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
