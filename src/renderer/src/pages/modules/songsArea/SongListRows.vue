<script setup lang="ts">
import { PropType, reactive, markRaw } from 'vue'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'
import type { ComponentPublicInstance } from 'vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'

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
  // 新增：拖拽相关的props
  sourceLibraryName: {
    type: String,
    required: true
  },
  sourceSongListUUID: {
    type: String,
    required: true
  }
})

const emit = defineEmits<{
  (e: 'song-click', event: MouseEvent, song: ISongInfo): void
  (e: 'song-contextmenu', event: MouseEvent, song: ISongInfo): void
  (e: 'song-dblclick', song: ISongInfo): void
  // 新增：拖拽相关的事件
  (e: 'song-dragstart', event: DragEvent, song: ISongInfo): void
  (e: 'song-dragend', event: DragEvent): void
  (e: 'rows-rendered', count: number): void
}>()

// 记录每个单元格 DOM，用于气泡锚定（非响应，减少依赖跟踪）
const cellRefMap = markRaw({} as Record<string, HTMLElement | null>)
const getCellKey = (song: ISongInfo, colKey: string) => `${song.filePath}__${colKey}`
const setCellRef = (key: string, el: Element | ComponentPublicInstance | null) => {
  let dom: HTMLElement | null = null
  if (el) {
    if (el instanceof HTMLElement) {
      dom = el
    } else if ((el as any).$el instanceof HTMLElement) {
      dom = (el as any).$el as HTMLElement
    }
  }
  cellRefMap[key] = dom
}

// 渲染完成观测：当 songs 变化后，等待一帧统计行数并上报
import { nextTick, watch, ref as vRef } from 'vue'
const rowsRoot = vRef<HTMLElement | null>(null)
// 按需展示气泡：仅在鼠标悬停的单元格渲染 bubbleBox，避免批量挂载
const hoveredCellKey = vRef<string | null>(null)
// 移除 rows 渲染观测，避免大 DOM 遍历

// 事件委托，减少每行 addEventListener 带来的开销
const onRowsClick = (e: MouseEvent) => {
  e.stopPropagation()
  const row = (e.target as HTMLElement)?.closest('.song-row-item') as HTMLElement | null
  if (!row) return
  const fp = row.dataset.filepath
  const song = props.songs.find((s) => s.filePath === fp)
  if (song) emit('song-click', e, song)
}
const onRowsContextmenu = (e: MouseEvent) => {
  e.stopPropagation()
  const row = (e.target as HTMLElement)?.closest('.song-row-item') as HTMLElement | null
  if (!row) return
  const fp = row.dataset.filepath
  const song = props.songs.find((s) => s.filePath === fp)
  if (song) emit('song-contextmenu', e, song)
}
const onRowsDblclick = (e: MouseEvent) => {
  e.stopPropagation()
  const row = (e.target as HTMLElement)?.closest('.song-row-item') as HTMLElement | null
  if (!row) return
  const fp = row.dataset.filepath
  const song = props.songs.find((s) => s.filePath === fp)
  if (song) emit('song-dblclick', song)
}

const onRowsMouseOver = (e: MouseEvent) => {
  const cell = (e.target as HTMLElement)?.closest('.cell-title') as HTMLElement | null
  if (!cell) return
  const key = cell.dataset.key
  if (key) hoveredCellKey.value = key
}
const onRowsMouseLeave = () => {
  hoveredCellKey.value = null
}
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
    <!-- Outer wrapper for all song rows -->
    <div
      v-for="(song, index) in songs"
      :key="song.filePath"
      class="song-row-item unselectable"
      :data-filepath="song.filePath"
      :draggable="true"
      @dragstart.stop="$emit('song-dragstart', $event, song)"
      @dragend.stop="$emit('song-dragend', $event)"
    >
      <div
        class="song-row-content"
        :class="{
          lightBackground: index % 2 === 1 && !selectedSongFilePaths.includes(song.filePath),
          darkBackground: index % 2 === 0 && !selectedSongFilePaths.includes(song.filePath),
          selectedSong: selectedSongFilePaths.includes(song.filePath),
          playingSong: song.filePath === playingSongFilePath
        }"
        :style="{ 'min-width': totalWidth + 'px' }"
      >
        <template v-for="col in visibleColumns" :key="col.key">
          <div v-if="col.key === 'index'" class="cell-title" :style="{ width: col.width + 'px' }">
            {{ index + 1 }}
          </div>
          <div
            v-else
            class="cell-title"
            :style="{ width: col.width + 'px' }"
            :ref="(el) => setCellRef(getCellKey(song, col.key), el)"
            :data-key="getCellKey(song, col.key)"
          >
            {{ song[col.key as keyof ISongInfo] }}
            <bubbleBox
              v-if="hoveredCellKey === getCellKey(song, col.key)"
              :dom="cellRefMap[getCellKey(song, col.key)] || undefined"
              :title="String((song as any)[col.key] ?? '')"
              :only-when-overflow="true"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
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
    background-color: #191919;
  }
  &.darkBackground {
    background-color: #000000;
  }
  &.selectedSong {
    background-color: #37373d;
  }
  &.playingSong {
    color: #0078d4 !important;
    font-weight: bold;
  }
}

.cell-title {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  border-bottom: 1px solid #2b2b2b;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding-left: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.unselectable {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
</style>
