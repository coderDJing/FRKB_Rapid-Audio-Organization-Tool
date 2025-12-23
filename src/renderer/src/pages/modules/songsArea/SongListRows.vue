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
import { useVirtualRows } from './SongListRows/useVirtualRows'
import { useSongRowEvents } from './SongListRows/useSongRowEvents'
import { useCoverThumbnails } from './SongListRows/useCoverThumbnails'
import { useCoverPreview } from './SongListRows/useCoverPreview'
import { t } from '@renderer/utils/translate'

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
  }
})

const emit = defineEmits<{
  (e: 'song-click', event: MouseEvent, song: ISongInfo): void
  (e: 'song-contextmenu', event: MouseEvent, song: ISongInfo): void
  (e: 'song-dblclick', song: ISongInfo): void
  (e: 'song-dragstart', event: DragEvent, song: ISongInfo): void
  (e: 'song-dragend', event: DragEvent): void
  (e: 'rows-rendered', count: number): void
}>()

const songsRef = toRef(props, 'songs')
const scrollHostElementRef = toRef(props, 'scrollHostElement')
const externalScrollTopRef = toRef(props, 'externalScrollTop')
const externalViewportHeightRef = toRef(props, 'externalViewportHeight')
const songListRootDirRef = toRef(props, 'songListRootDir')

const cellRefMap = markRaw({} as Record<string, HTMLElement | null>)
const coverCellRefMap = markRaw(new Map<string, HTMLElement | null>())
const getCellKey = (song: ISongInfo, colKey: string) => `${song.filePath}__${colKey}`
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

const formatSelectionLabel = (label: ISongInfo['selectionLabel'] | undefined) => {
  if (label === 'liked') return t('selection.liked')
  if (label === 'disliked') return t('selection.disliked')
  return ''
}

const getCellDisplayText = (song: ISongInfo, colKey: string): string => {
  if (colKey === 'selectionLabel') {
    return formatSelectionLabel(song.selectionLabel)
  }
  return String((song as any)?.[colKey] ?? '')
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
  startIndex,
  endIndex,
  visibleCount,
  scrollLeft
} = useVirtualRows({
  songs: songsRef,
  scrollHostElement: scrollHostElementRef,
  externalScrollTop: externalScrollTopRef,
  externalViewportHeight: externalViewportHeightRef
})

const { onRowsClick, onRowsContextmenu, onRowsDblclick } = useSongRowEvents({
  songs: songsRef,
  emitSongClick: (e, song) => emit('song-click', e, song),
  emitSongContextmenu: (e, song) => emit('song-contextmenu', e, song),
  emitSongDblclick: (song) => emit('song-dblclick', song)
})

const { coversTick, getCoverUrl, fetchCoverUrl, onImgError } = useCoverThumbnails({
  songs: songsRef,
  visibleSongsWithIndex,
  startIndex,
  endIndex,
  visibleCount,
  songListRootDir: songListRootDirRef
})

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

const onRowsMouseOver = (e: MouseEvent) => {
  const cell = (e.target as HTMLElement)?.closest('.cell-title') as HTMLElement | null
  if (!cell) return
  const key = cell.dataset.key
  if (key) hoveredCellKey.value = key
}
const onRowsMouseLeave = (e: MouseEvent) => {
  const rt = (e && (e.relatedTarget as HTMLElement | null)) || null
  if (rt && typeof rt.closest === 'function') {
    if (rt.closest('.frkb-bubble') || rt.closest('.cover-preview-overlay')) {
      return
    }
  }
  hoveredCellKey.value = null
  closeCoverPreview()
}

const handleCoverDblclick = (song: ISongInfo, event: MouseEvent) => {
  event.stopPropagation()
  event.preventDefault()
  closeCoverPreview()
  emit('song-dblclick', song)
}

const handleCoverPreviewDblclick = (event: MouseEvent) => {
  event.stopPropagation()
  event.preventDefault()
  const idx =
    coverPreviewState.anchorIndex >= 0
      ? coverPreviewState.anchorIndex
      : coverPreviewState.displayIndex
  const song = typeof idx === 'number' ? songsRef.value?.[idx] : null
  if (song) {
    closeCoverPreview()
    emit('song-dblclick', song)
  }
}

const handleCoverPreviewContextmenu = (event: MouseEvent) => {
  event.stopPropagation()
  event.preventDefault()
  const idx =
    coverPreviewState.displayIndex >= 0
      ? coverPreviewState.displayIndex
      : coverPreviewState.anchorIndex
  const song = typeof idx === 'number' ? songsRef.value?.[idx] : null
  if (song) {
    emit('song-contextmenu', event, song)
  }
}

onUnmounted(() => {
  coverCellRefMap.clear()
})
</script>

<template>
  <div
    ref="rowsRoot"
    @click="onRowsClick"
    @contextmenu.prevent="onRowsContextmenu"
    @dblclick="onRowsDblclick"
    @mouseover="onRowsMouseOver"
    @mouseleave="onRowsMouseLeave"
  >
    <!-- 使用占位高度撑开总可滚动高度，内部仅渲染可视窗口行 -->
    <div :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div :style="{ position: 'absolute', top: offsetTopPx + 'px', left: 0, right: 0 }">
        <div
          v-for="item in visibleSongsWithIndex"
          :key="item.song.filePath"
          class="song-row-item unselectable"
          :data-filepath="item.song.filePath"
          :draggable="true"
          @dragstart.stop="$emit('song-dragstart', $event, item.song)"
          @dragend.stop="$emit('song-dragend', $event)"
        >
          <div
            class="song-row-content"
            :class="{
              lightBackground:
                item.idx % 2 === 1 && !selectedSongFilePaths.includes(item.song.filePath),
              darkBackground:
                item.idx % 2 === 0 && !selectedSongFilePaths.includes(item.song.filePath),
              selectedSong: selectedSongFilePaths.includes(item.song.filePath),
              playingSong: item.song.filePath === playingSongFilePath
            }"
            :style="{ 'min-width': `var(--songs-total-width, ${totalWidth}px)` }"
          >
            <template v-for="col in visibleColumns" :key="col.key">
              <div
                v-if="col.key === 'index'"
                class="cell-title"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
              >
                {{ item.idx + 1 }}
              </div>
              <div
                v-else-if="col.key === 'cover'"
                class="cell-cover"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
              >
                <div
                  class="cover-wrapper"
                  :data-ct="coversTick"
                  :ref="(el) => setCoverCellRef(item.song.filePath, el)"
                  @mouseenter="onCoverMouseEnter(item.idx, $event)"
                  @mouseleave="onCoverMouseLeave(item.idx, $event)"
                  @dblclick.stop.prevent="handleCoverDblclick(item.song, $event)"
                >
                  <img
                    v-if="getCoverUrl(item.song.filePath)"
                    :src="getCoverUrl(item.song.filePath) as string"
                    alt="cover"
                    decoding="async"
                    :key="getCoverUrl(item.song.filePath) || item.song.filePath + '-ph'"
                    @error="onImgError(item.song.filePath)"
                  />
                  <div v-else class="cover-skeleton"></div>
                </div>
              </div>
              <div
                v-else
                class="cell-title"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                :ref="(el) => setCellRef(getCellKey(item.song, col.key), el)"
                :data-key="getCellKey(item.song, col.key)"
              >
                {{ getCellDisplayText(item.song, col.key) }}
                <bubbleBox
                  v-if="hoveredCellKey === getCellKey(item.song, col.key)"
                  :dom="cellRefMap[getCellKey(item.song, col.key)] || undefined"
                  :title="getCellDisplayText(item.song, col.key)"
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
      @contextmenu.stop.prevent="handleCoverPreviewContextmenu"
      @dblclick.stop.prevent="handleCoverPreviewDblclick"
    >
      <img v-if="previewedCoverUrl" :src="previewedCoverUrl" alt="cover preview" decoding="async" />
      <div v-else class="cover-skeleton expanded"></div>
    </div>
  </teleport>
</template>

<style lang="scss" scoped>
.song-row-item {
  font-size: 14px;
}

.song-row-content {
  display: flex;
  height: 30px; // Standard row height
  contain: content;

  &.lightBackground {
    background-color: var(--bg-elev);
  }
  &.darkBackground {
    background-color: var(--bg);
  }
  &.selectedSong {
    background-color: var(--hover);
  }
  &.playingSong {
    color: var(--accent) !important;
    font-weight: bold;
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
  overflow: hidden; // 保持单元格原有宽度
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.cover-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover; // 填满容器
  display: block;
  pointer-events: none; // 禁止拦截事件，防止拖拽
  -webkit-user-drag: none; // CSS 方式禁用拖拽
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
  // 通过双重阴影模拟描边，避免占用额外像素
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
