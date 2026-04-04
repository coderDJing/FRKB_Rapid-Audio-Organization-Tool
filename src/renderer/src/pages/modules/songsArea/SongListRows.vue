<script setup lang="ts">
import {
  PropType,
  computed,
  markRaw,
  onUnmounted,
  ref as vRef,
  toRef,
  type ComponentPublicInstance
} from 'vue'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { getKeyDisplayText as formatKeyDisplayText } from '@shared/keyDisplay'
import { t } from '@renderer/utils/translate'
import { formatDeletedAtMs, getOriginalPlaylistDisplay } from '@renderer/utils/recycleBinDisplay'
import libraryUtils from '@renderer/utils/libraryUtils'
import { useVirtualRows } from './SongListRows/useVirtualRows'
import { useSongRowEvents } from './SongListRows/useSongRowEvents'
import { useCoverThumbnails } from './SongListRows/useCoverThumbnails'
import { useKeyAnalysisQueue } from './SongListRows/useKeyAnalysisQueue'
import { useCoverPreview } from './SongListRows/useCoverPreview'
import { useSongRowHoverInteractions } from './SongListRows/useSongRowHoverInteractions'
import { useWaveformPreview } from './SongListRows/useWaveformPreview'

const props = defineProps({
  songs: {
    type: Array as PropType<ISongInfo[]>,
    required: true
  },
  visibleColumns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  selectedSongFilePaths: {
    type: Array as PropType<string[]>,
    required: true
  },
  playingSongFilePath: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  playingSongFilePaths: {
    type: Array as PropType<string[]>,
    default: () => []
  },
  flashRowKey: {
    type: String,
    default: ''
  },
  flashRowToken: {
    type: Number,
    default: 0
  },
  totalWidth: {
    type: Number,
    required: true
  },
  sourceLibraryName: {
    type: String,
    required: true
  },
  sourceSongListUUID: {
    type: String,
    required: true
  },
  scrollHostElement: {
    type: Object as PropType<HTMLElement | null | undefined>,
    default: undefined
  },
  externalScrollTop: {
    type: Number as PropType<number | undefined>,
    default: undefined
  },
  externalViewportHeight: {
    type: Number as PropType<number | undefined>,
    default: undefined
  },
  songListRootDir: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  externalWaveformRootPath: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  readOnly: {
    type: Boolean,
    default: false
  },
  enableCoverThumbnails: {
    type: Boolean,
    default: true
  },
  enableKeyAnalysisQueue: {
    type: Boolean,
    default: true
  },
  allowContextMenuWhenReadOnly: { type: Boolean, default: false },
  allowDblclickWhenReadOnly: { type: Boolean, default: false },
  allowWaveformPreviewWhenReadOnly: { type: Boolean, default: false }
})

const emit = defineEmits<{
  (e: 'song-click', event: MouseEvent, song: ISongInfo): void
  (e: 'song-contextmenu', event: MouseEvent, song: ISongInfo): void
  (e: 'song-dblclick', song: ISongInfo, event: MouseEvent): void
  (e: 'song-dragstart', event: DragEvent, song: ISongInfo): void
  (e: 'song-dragend', event: DragEvent): void
  (e: 'mixtape-reorder', payload: { sourceItemIds: string[]; targetIndex: number }): void
  (e: 'rows-rendered', count: number): void
}>()

const songsRef = toRef(props, 'songs')
const scrollHostElementRef = toRef(props, 'scrollHostElement')
const externalScrollTopRef = toRef(props, 'externalScrollTop')
const externalViewportHeightRef = toRef(props, 'externalViewportHeight')
const songListRootDirRef = toRef(props, 'songListRootDir')
const externalWaveformRootPathRef = toRef(props, 'externalWaveformRootPath')
const enableCoverThumbnailsRef = toRef(props, 'enableCoverThumbnails')
const enableKeyAnalysisQueueRef = toRef(props, 'enableKeyAnalysisQueue')
const visibleColumnsRef = toRef(props, 'visibleColumns')
const runtime = useRuntimeStore()
const playingSongRowKeySet = computed(
  () =>
    new Set(
      [
        ...(Array.isArray(props.playingSongFilePaths) ? props.playingSongFilePaths : []),
        props.playingSongFilePath
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
)
const isMixtapeList = computed(
  () => libraryUtils.getLibraryTreeByUUID(props.sourceSongListUUID)?.type === 'mixtapeList'
)
const canPreviewWaveform = computed(() => !props.readOnly || props.allowWaveformPreviewWhenReadOnly)

const cellRefMap = markRaw({} as Record<string, HTMLElement | null>)
const coverCellRefMap = markRaw(new Map<string, HTMLElement | null>())
const getRowKey = (song: ISongInfo) => song.mixtapeItemId || song.filePath
const getCellKey = (song: ISongInfo, colKey: string) => `${getRowKey(song)}__${colKey}`
const resolveHTMLElement = (el: Element | ComponentPublicInstance | null) => {
  if (el && typeof (el as ComponentPublicInstance).$el !== 'undefined') {
    return ((el as ComponentPublicInstance).$el || null) as Element | null
  }
  return el as Element | null
}
const setCellRef = (key: string, el: Element | ComponentPublicInstance | null) => {
  const dom = resolveHTMLElement(el) as HTMLElement | null
  cellRefMap[key] = dom
}
const setCoverCellRef = (filePath: string, el: Element | ComponentPublicInstance | null) => {
  const dom = resolveHTMLElement(el) as HTMLElement | null
  if (dom) {
    coverCellRefMap.set(filePath, dom)
  } else {
    coverCellRefMap.delete(filePath)
  }
}

const hoveredCellKey = vRef<string | null>(null)
const onlyWhenOverflowComputed = computed(() => true)
const DEFAULT_ROW_HEIGHT = 30
const dragHoverIndex = vRef<number | null>(null)
const dragHoverPosition = vRef<'before' | 'after' | null>(null)
const dragHoverEdge = vRef<'top' | 'bottom' | null>(null)
const clearDragHover = () => {
  dragHoverIndex.value = null
  dragHoverPosition.value = null
  dragHoverEdge.value = null
}
const draggingItemIds = vRef<string[]>([])
const draggingSourceListUUID = vRef('')
const lastAutoScrollAt = vRef(0)
const AUTO_SCROLL_EDGE_PX = 36
const AUTO_SCROLL_STEP_PX = 22
const AUTO_SCROLL_MIN_INTERVAL = 16
const topPadVisible = vRef(false)
const bottomPadVisible = vRef(false)
const topPadStyle = vRef<Record<string, string>>({})
const bottomPadStyle = vRef<Record<string, string>>({})
const resolveDragHost = () =>
  (viewportElement.value || scrollHostElementRef.value || rowsRoot.value) as HTMLElement | null
const resolveDropContainer = () => {
  const rows = rowsRoot.value
  if (!rows) return null
  const shell = rows.closest('.songs-area-shell') as HTMLElement | null
  return shell || rows
}

const updateDropPadRects = () => {
  const rows = rowsRoot.value
  const container = resolveDropContainer()
  if (!rows || !container) {
    topPadVisible.value = false
    bottomPadVisible.value = false
    return
  }
  const cRect = container.getBoundingClientRect()
  const rRect = rows.getBoundingClientRect()
  const topHeight = Math.max(0, Math.min(rRect.top, cRect.bottom) - cRect.top)
  if (topHeight > 0) {
    topPadVisible.value = true
    topPadStyle.value = {
      top: `${cRect.top}px`,
      left: `${cRect.left}px`,
      width: `${cRect.width}px`,
      height: `${topHeight}px`
    }
  } else {
    topPadVisible.value = false
  }
  const listLen = totalHeight.value
  const safeScrollTop = Math.max(0, Math.min(effectiveScrollTop.value, listLen))
  const listEndY = rRect.top + (listLen - safeScrollTop)
  const bottomStart = Math.min(Math.max(listEndY, rRect.top), cRect.bottom)
  const bottomHeight = Math.max(0, cRect.bottom - bottomStart)
  if (bottomHeight > 0) {
    bottomPadVisible.value = true
    bottomPadStyle.value = {
      top: `${bottomStart}px`,
      left: `${cRect.left}px`,
      width: `${cRect.width}px`,
      height: `${bottomHeight}px`
    }
  } else {
    bottomPadVisible.value = false
  }
}
const scheduleAutoScroll = (event: DragEvent) => {
  const host = resolveDragHost()
  if (!host) return
  const rect = host.getBoundingClientRect()
  const y = event.clientY
  const distanceTop = y - rect.top
  const distanceBottom = rect.bottom - y
  let delta = 0
  if (distanceTop < AUTO_SCROLL_EDGE_PX) {
    delta = -AUTO_SCROLL_STEP_PX
  } else if (distanceBottom < AUTO_SCROLL_EDGE_PX) {
    delta = AUTO_SCROLL_STEP_PX
  }
  if (!delta) return
  const now = performance.now()
  if (now - lastAutoScrollAt.value < AUTO_SCROLL_MIN_INTERVAL) return
  lastAutoScrollAt.value = now
  host.scrollTop += delta
}

const getKeyDisplayText = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
  const display = formatKeyDisplayText(text, style)
  if (display.toLowerCase() === 'o') {
    return t('player.keyDisplayNone')
  }
  return display
}

const getCellValue = (song: ISongInfo, colKey: string): string | number => {
  if (colKey === 'key') {
    return getKeyDisplayText((song as any).key)
  }
  if (colKey === 'deletedAtMs') {
    return formatDeletedAtMs((song as any).deletedAtMs)
  }
  if (colKey === 'originalPlaylistPath') {
    return getOriginalPlaylistDisplay(song)
  }
  const raw = (song as any)[colKey]
  if (colKey === 'bpm') {
    const bpm = Number(raw)
    return Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(2) : ''
  }
  if (raw === undefined || raw === null) return ''
  return raw as string | number
}

const {
  rowsRoot,
  hostElement,
  viewportElement,
  visibleSongsWithIndex,
  offsetTopPx,
  totalHeight,
  rowHeight,
  effectiveScrollTop,
  effectiveViewportHeight,
  startIndex,
  endIndex,
  actualStartIndex,
  actualEndIndex,
  visibleCount,
  scrollLeft
} = useVirtualRows({
  songs: songsRef,
  scrollHostElement: scrollHostElementRef,
  externalScrollTop: externalScrollTopRef,
  externalViewportHeight: externalViewportHeightRef
})

const contentHeight = computed(() =>
  Math.max(totalHeight.value, effectiveViewportHeight.value || 0)
)

const shouldSuppressPointerAction = (event?: MouseEvent) => {
  if (runtime.songDragSuppressClickUntilMs <= Date.now()) return false
  event?.stopPropagation()
  event?.preventDefault()
  return true
}

const { onRowsClick, onRowsContextmenu, onRowsDblclick } = useSongRowEvents({
  songs: songsRef,
  emitSongClick: (e, song) => emit('song-click', e, song),
  emitSongContextmenu: (e, song) => emit('song-contextmenu', e, song),
  emitSongDblclick: (song, event) => emit('song-dblclick', song, event),
  shouldSuppressPointerAction
})

const { coversTick, getCoverUrl, fetchCoverUrl, onImgError } = useCoverThumbnails({
  songs: songsRef,
  visibleSongsWithIndex,
  startIndex,
  endIndex,
  visibleCount,
  songListRootDir: songListRootDirRef,
  enabled: enableCoverThumbnailsRef
})

useKeyAnalysisQueue({ visibleSongsWithIndex, enabled: enableKeyAnalysisQueueRef })

const {
  coverPreviewState,
  coverPreviewSize,
  previewedCoverUrl,
  onCoverMouseEnter,
  onCoverMouseLeave,
  handleCoverPreviewMouseMove,
  closeCoverPreview
} = useCoverPreview({
  songs: songsRef,
  rowsRoot,
  hostElement,
  viewportElement,
  coverCellRefMap,
  rowHeight,
  defaultRowHeight: DEFAULT_ROW_HEIGHT,
  getCoverUrl,
  fetchCoverUrl,
  effectiveScrollTop,
  scrollLeft
})

const {
  setWaveformCanvasRef,
  getWaveformClickPercent,
  requestWaveformPreview,
  stopWaveformPreview,
  isWaveformPreviewActive,
  getWaveformPreviewPlayheadStyle,
  getWaveformPlaceholderText,
  getWaveformPlaceholderTitle
} = useWaveformPreview({
  visibleSongsWithIndex,
  visibleColumns: visibleColumnsRef,
  songListRootDir: songListRootDirRef,
  externalWaveformRootPath: externalWaveformRootPathRef,
  actualVisibleStartIndex: actualStartIndex,
  actualVisibleEndIndex: actualEndIndex
})

const handleWaveformClick = (song: ISongInfo, event: MouseEvent) => {
  if (shouldSuppressPointerAction(event)) return
  if (!canPreviewWaveform.value) return
  if (event.button !== 0) return
  const filePath = song?.filePath
  if (!filePath) return
  const percent = getWaveformClickPercent(filePath, event.clientX)
  requestWaveformPreview(song, percent)
}

const handleWaveformStopClick = (event: MouseEvent) => {
  if (shouldSuppressPointerAction(event)) return
  if (!canPreviewWaveform.value) return
  event.stopPropagation()
  event.preventDefault()
  stopWaveformPreview()
}

const isSelfExternalSongDrag = () =>
  runtime.songDragMode === 'external' &&
  runtime.songDragActive &&
  runtime.draggingSongFilePaths.length > 0

const resolveDragPayload = (event: DragEvent) => {
  if (
    draggingItemIds.value.length > 0 &&
    draggingSourceListUUID.value === props.sourceSongListUUID
  ) {
    return {
      sourceSongListUUID: draggingSourceListUUID.value,
      itemIds: [...draggingItemIds.value]
    }
  }
  const raw = event.dataTransfer?.getData('application/x-mixtape-reorder')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const resolveDragItemIds = (event: DragEvent): string[] => {
  const parsed: any = resolveDragPayload(event)
  if (!parsed || parsed.sourceSongListUUID !== props.sourceSongListUUID) return []
  const sourceItemIds = Array.isArray(parsed?.itemIds)
    ? parsed.itemIds.map((id: any) => String(id)).filter(Boolean)
    : []
  return sourceItemIds
}

const handleRowDragOver = (event: DragEvent, item: { song: ISongInfo; idx: number }) => {
  if (props.readOnly) return
  if (isSelfExternalSongDrag()) {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'none'
    }
    clearDragHover()
    return
  }
  if (!isMixtapeList.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  updateDropPadRects()
  const targetId = item?.song?.mixtapeItemId
  if (targetId && sourceItemIds.includes(targetId)) {
    clearDragHover()
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  const row = event.currentTarget as HTMLElement | null
  if (!row) return
  const rect = row.getBoundingClientRect()
  const offsetY = event.clientY - rect.top
  dragHoverIndex.value = item.idx
  dragHoverPosition.value = offsetY < rect.height / 2 ? 'before' : 'after'
  dragHoverEdge.value = null
  scheduleAutoScroll(event)
}

const handleEdgeDragOver = (event: DragEvent, edge: 'top' | 'bottom') => {
  if (props.readOnly) return
  if (!isMixtapeList.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  updateDropPadRects()
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragHoverEdge.value = edge
  dragHoverIndex.value = null
  dragHoverPosition.value = null
  scheduleAutoScroll(event)
}

const handleEdgeDrop = (event: DragEvent, edge: 'top' | 'bottom') => {
  if (props.readOnly) return
  if (!isMixtapeList.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  const listLen = songsRef.value.length
  if (listLen === 0) {
    clearDragHover()
    return
  }
  const targetIndex = edge === 'top' ? 0 : listLen
  clearDragHover()
  emit('mixtape-reorder', { sourceItemIds, targetIndex })
}

const handleTopPadDragOver = (event: DragEvent) => {
  updateDropPadRects()
  handleEdgeDragOver(event, 'top')
}

const handleBottomPadDragOver = (event: DragEvent) => {
  updateDropPadRects()
  handleEdgeDragOver(event, 'bottom')
}

const handleTopPadDrop = (event: DragEvent) => {
  updateDropPadRects()
  handleEdgeDrop(event, 'top')
}

const handleBottomPadDrop = (event: DragEvent) => {
  updateDropPadRects()
  handleEdgeDrop(event, 'bottom')
}

const handleRowDrop = (event: DragEvent, item: { song: ISongInfo; idx: number }) => {
  if (props.readOnly) return
  if (isSelfExternalSongDrag()) {
    event.preventDefault()
    event.stopPropagation()
    clearDragHover()
    return
  }
  if (!isMixtapeList.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  event.preventDefault()
  event.stopPropagation()
  const targetId = item.song?.mixtapeItemId
  if (targetId && sourceItemIds.includes(targetId)) {
    clearDragHover()
    return
  }
  const row = event.currentTarget as HTMLElement | null
  let position: 'before' | 'after' = 'before'
  if (row) {
    const rect = row.getBoundingClientRect()
    const offsetY = event.clientY - rect.top
    position = offsetY < rect.height / 2 ? 'before' : 'after'
  }
  clearDragHover()
  const targetIndex = item.idx + (position === 'after' ? 1 : 0)
  emit('mixtape-reorder', { sourceItemIds, targetIndex })
}

const handleRowDragEnd = (event: DragEvent) => {
  if (props.readOnly) return
  draggingItemIds.value = []
  draggingSourceListUUID.value = ''
  clearDragHover()
  topPadVisible.value = false
  bottomPadVisible.value = false
  emit('song-dragend', event)
}

const handleRowDragStart = (event: DragEvent, item: { song: ISongInfo }) => {
  if (props.readOnly) return
  if (isMixtapeList.value) {
    const rowKey = getRowKey(item.song)
    const selectedKeys = (props.selectedSongFilePaths || []).filter(Boolean)
    const shouldUseSelection = rowKey.length > 0 && selectedKeys.includes(rowKey)
    const fallbackId = rowKey.length > 0 ? [rowKey] : []
    draggingItemIds.value = shouldUseSelection ? [...selectedKeys] : fallbackId
    draggingSourceListUUID.value = props.sourceSongListUUID
    if (event.dataTransfer && draggingItemIds.value.length > 0) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(
        'application/x-mixtape-reorder',
        JSON.stringify({
          sourceSongListUUID: props.sourceSongListUUID,
          itemIds: [...draggingItemIds.value]
        })
      )
    }
    updateDropPadRects()
  }
  emit('song-dragstart', event, item.song)
}

const {
  onRowsMouseOver,
  onRowsMouseLeave,
  handleCoverDblclick,
  handleCoverPreviewDblclick,
  handleCoverPreviewContextmenu
} = useSongRowHoverInteractions({
  hoveredCellKey,
  songs: songsRef,
  coverPreviewState,
  closeCoverPreview,
  emitSongContextmenu: (event, song) => emit('song-contextmenu', event, song),
  emitSongDblclick: (song, event) => emit('song-dblclick', song, event),
  shouldSuppressPointerAction
})

onUnmounted(() => {
  coverCellRefMap.clear()
})
</script>

<template>
  <div
    ref="rowsRoot"
    class="song-rows-root"
    @click="onRowsClick"
    @contextmenu.prevent="
      (!props.readOnly || props.allowContextMenuWhenReadOnly) && onRowsContextmenu($event)
    "
    @dblclick="(!props.readOnly || props.allowDblclickWhenReadOnly) && onRowsDblclick($event)"
    @mouseover="onRowsMouseOver"
    @mouseleave="onRowsMouseLeave"
  >
    <div :style="{ height: contentHeight + 'px', position: 'relative' }">
      <div :style="{ position: 'absolute', top: offsetTopPx + 'px', left: 0, right: 0 }">
        <div
          v-for="item in visibleSongsWithIndex"
          :key="item.song.mixtapeItemId || item.song.filePath"
          class="song-row-item unselectable"
          :class="{
            'drag-over-before':
              isMixtapeList && dragHoverIndex === item.idx && dragHoverPosition === 'before',
            'drag-over-after':
              isMixtapeList && dragHoverIndex === item.idx && dragHoverPosition === 'after'
          }"
          :data-filepath="item.song.filePath"
          :data-rowkey="getRowKey(item.song)"
          :draggable="!props.readOnly"
          @dragstart.stop="!props.readOnly && handleRowDragStart($event, item)"
          @dragend.stop="!props.readOnly && handleRowDragEnd($event)"
          @dragover="!props.readOnly && handleRowDragOver($event, item)"
          @drop="!props.readOnly && handleRowDrop($event, item)"
        >
          <div
            class="song-row-content"
            :class="{
              lightBackground:
                item.idx % 2 === 1 && !selectedSongFilePaths.includes(getRowKey(item.song)),
              darkBackground:
                item.idx % 2 === 0 && !selectedSongFilePaths.includes(getRowKey(item.song)),
              selectedSong: selectedSongFilePaths.includes(getRowKey(item.song)),
              playingSong: playingSongRowKeySet.has(getRowKey(item.song)),
              globalSearchFlashA:
                flashRowKey === getRowKey(item.song) &&
                flashRowToken > 0 &&
                flashRowToken % 2 === 1,
              globalSearchFlashB:
                flashRowKey === getRowKey(item.song) && flashRowToken > 0 && flashRowToken % 2 === 0
            }"
            :style="{ 'min-width': `var(--songs-total-width, ${totalWidth}px)` }"
          >
            <template v-for="col in visibleColumns" :key="col.key">
              <div
                v-if="col.key === 'index'"
                class="cell-title"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
              >
                {{
                  typeof item.song.mixOrder === 'number' && item.song.mixOrder > 0
                    ? item.song.mixOrder
                    : item.idx + 1
                }}
              </div>
              <div
                v-else-if="col.key === 'cover'"
                class="cell-cover"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
              >
                <div
                  :ref="(el) => setCoverCellRef(item.song.filePath, el)"
                  class="cover-wrapper"
                  :data-ct="coversTick"
                  @mouseenter="onCoverMouseEnter(item.idx, $event)"
                  @mouseleave="onCoverMouseLeave(item.idx, $event)"
                  @dblclick.stop.prevent="
                    (!props.readOnly || props.allowDblclickWhenReadOnly) &&
                    handleCoverDblclick(item.song, $event)
                  "
                >
                  <img
                    v-if="getCoverUrl(item.song.filePath)"
                    :key="getCoverUrl(item.song.filePath) || item.song.filePath + '-ph'"
                    :src="getCoverUrl(item.song.filePath) as string"
                    alt="cover"
                    decoding="async"
                    @error="onImgError(item.song.filePath)"
                  />
                  <div v-else class="cover-skeleton"></div>
                </div>
              </div>
              <div
                v-else-if="col.key === 'waveformPreview'"
                class="cell-waveform"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                @click="canPreviewWaveform && handleWaveformClick(item.song, $event)"
              >
                <div class="waveform-preview-stop-slot">
                  <button
                    v-if="isWaveformPreviewActive(item.song.filePath)"
                    class="waveform-preview-stop"
                    type="button"
                    aria-label="Stop preview"
                    @click="canPreviewWaveform && handleWaveformStopClick($event)"
                  ></button>
                </div>
                <div class="waveform-preview-shell">
                  <canvas
                    :ref="
                      (el) =>
                        setWaveformCanvasRef(item.song.filePath, el as HTMLCanvasElement | null)
                    "
                    class="waveform-preview-canvas"
                  ></canvas>
                  <div
                    v-if="getWaveformPlaceholderText(item.song.filePath)"
                    class="waveform-preview-placeholder"
                    :title="getWaveformPlaceholderTitle(item.song.filePath)"
                  >
                    {{ getWaveformPlaceholderText(item.song.filePath) }}
                  </div>
                  <div
                    v-if="isWaveformPreviewActive(item.song.filePath)"
                    class="waveform-preview-playhead"
                    :style="getWaveformPreviewPlayheadStyle(item.song.filePath)"
                  ></div>
                </div>
              </div>
              <div
                v-else
                :ref="(el) => setCellRef(getCellKey(item.song, col.key), el)"
                class="cell-title"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                :data-key="getCellKey(item.song, col.key)"
              >
                {{ getCellValue(item.song, col.key) }}
                <bubbleBox
                  v-if="hoveredCellKey === getCellKey(item.song, col.key)"
                  :dom="cellRefMap[getCellKey(item.song, col.key)] || undefined"
                  :title="String(getCellValue(item.song, col.key))"
                  :only-when-overflow="onlyWhenOverflowComputed"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
  <teleport to="body">
    <div
      v-if="isMixtapeList && draggingItemIds.length > 0 && topPadVisible"
      class="mixtape-drop-pad mixtape-drop-pad--top"
      :class="{ 'is-active': dragHoverEdge === 'top' }"
      :style="topPadStyle"
      @dragenter.stop.prevent="handleTopPadDragOver"
      @dragover.stop.prevent="handleTopPadDragOver"
      @drop.stop.prevent="handleTopPadDrop"
    ></div>
    <div
      v-if="isMixtapeList && draggingItemIds.length > 0 && bottomPadVisible"
      class="mixtape-drop-pad mixtape-drop-pad--bottom"
      :class="{ 'is-active': dragHoverEdge === 'bottom' }"
      :style="bottomPadStyle"
      @dragenter.stop.prevent="handleBottomPadDragOver"
      @dragover.stop.prevent="handleBottomPadDragOver"
      @drop.stop.prevent="handleBottomPadDrop"
    ></div>
    <div
      v-if="coverPreviewState.active"
      class="cover-preview-overlay"
      :style="{
        top: coverPreviewState.overlayTop + 'px',
        left: coverPreviewState.overlayLeft + 'px',
        width: coverPreviewState.overlayWidth + 'px',
        height: coverPreviewSize + 'px'
      }"
      @mousemove="handleCoverPreviewMouseMove"
      @mouseleave="closeCoverPreview"
      @contextmenu.stop.prevent="
        (!props.readOnly || props.allowContextMenuWhenReadOnly) &&
        handleCoverPreviewContextmenu($event)
      "
      @dblclick.stop.prevent="
        (!props.readOnly || props.allowDblclickWhenReadOnly) && handleCoverPreviewDblclick($event)
      "
    >
      <img v-if="previewedCoverUrl" :src="previewedCoverUrl" alt="cover preview" decoding="async" />
      <div v-else class="cover-skeleton expanded"></div>
    </div>
  </teleport>
</template>

<style lang="scss" scoped>
.song-row-item {
  font-size: 14px;
  position: relative;
}

.song-row-item.drag-over-before::before,
.song-row-item.drag-over-after::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
  z-index: 2;
}

.song-row-item.drag-over-before::before {
  top: 0;
}

.song-row-item.drag-over-after::after {
  bottom: 0;
}

.song-rows-root {
  position: relative;
  min-height: 100%;
}

.mixtape-drop-pad {
  position: fixed;
  z-index: 3500;
  pointer-events: auto;
  background: transparent;
}

.mixtape-drop-pad.is-active::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}

.mixtape-drop-pad--top.is-active::after {
  bottom: 0;
}

.mixtape-drop-pad--bottom.is-active::after {
  top: 0;
}

.song-row-content {
  display: flex;
  height: 30px; // Standard row height
  contain: content;
  position: relative;

  &.lightBackground {
    background-color: var(--bg-elev);
  }
  &.darkBackground {
    background-color: var(--bg);
  }
  &.selectedSong {
    background-color: rgba(0, 120, 212, 0.2);
  }
  &.selectedSong::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent);
    z-index: 1;
  }
  &.playingSong {
    color: var(--accent) !important;
    font-weight: bold;
  }
  &.globalSearchFlashA,
  &.globalSearchFlashB {
    animation-duration: 320ms;
    animation-timing-function: cubic-bezier(0.32, 0, 0.2, 1);
    animation-iteration-count: 3;
  }
  &.globalSearchFlashA::before,
  &.globalSearchFlashB::before {
    animation-duration: 320ms;
    animation-timing-function: cubic-bezier(0.32, 0, 0.2, 1);
    animation-iteration-count: 3;
  }
  &.globalSearchFlashA {
    animation-name: global-search-locate-flash-a;
  }
  &.globalSearchFlashB {
    animation-name: global-search-locate-flash-b;
  }
  &.globalSearchFlashA::before,
  &.globalSearchFlashB::before {
    animation-name: global-search-locate-flash-bar;
  }
}

@keyframes global-search-locate-flash-a {
  0%,
  100% {
    background-color: rgba(0, 120, 212, 0.2);
    box-shadow: none;
  }
  50% {
    background-color: rgba(74, 176, 255, 0.52);
    box-shadow: inset 0 0 0 1px rgba(120, 205, 255, 0.72);
  }
}

@keyframes global-search-locate-flash-b {
  0%,
  100% {
    background-color: rgba(0, 120, 212, 0.2);
    box-shadow: none;
  }
  50% {
    background-color: rgba(74, 176, 255, 0.52);
    box-shadow: inset 0 0 0 1px rgba(120, 205, 255, 0.72);
  }
}

@keyframes global-search-locate-flash-bar {
  0%,
  100% {
    width: 3px;
    background: var(--accent);
    box-shadow: none;
  }
  50% {
    width: 6px;
    background: #80d0ff;
    box-shadow: 0 0 12px rgba(128, 208, 255, 0.45);
  }
}

.cell-title {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding-left: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-waveform {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 12px 0 7px;
  position: relative;
  cursor: default;
  gap: 6px;
}

.waveform-preview-stop-slot {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.waveform-preview-shell {
  position: relative;
  width: 100%;
  height: 18px;
  flex: 1 1 auto;
  min-width: 0;
}

.waveform-preview-canvas {
  width: 100%;
  height: 18px;
  display: block;
  color: var(--text-weak);
  pointer-events: none;
}

.waveform-preview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  color: var(--text-weak);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.waveform-preview-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
}

.waveform-preview-stop {
  width: 16px;
  height: 16px;
  background: var(--accent);
  border: 1px solid var(--border);
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  z-index: 3;
  opacity: 0.95;
  appearance: none;
  outline: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.2),
    inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease,
    opacity 120ms ease;
}

.waveform-preview-stop::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: var(--bg);
}

.waveform-preview-stop:hover {
  opacity: 1;
  transform: scale(1.05);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.28),
    inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

.waveform-preview-stop:active {
  transform: scale(0.98);
}

.waveform-preview-stop:focus-visible {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent),
    0 2px 6px rgba(0, 0, 0, 0.28);
}

.cell-cover {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
}

.cover-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.cover-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
  -webkit-user-drag: none;
  user-select: none;
}
.cover-skeleton {
  width: 100%;
  height: 100%;
}
.cover-skeleton.expanded {
  background-color: var(--bg-elev);
}

.cover-preview-overlay {
  position: fixed;
  background-color: var(--bg-elev);
  box-shadow:
    0 0 0 2px var(--accent),
    0 10px 30px rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  z-index: 3000;
  overflow: hidden;
}
.cover-preview-overlay img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.unselectable {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
</style>
