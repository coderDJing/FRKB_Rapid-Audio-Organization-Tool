<script setup lang="ts">
import { PropType, reactive } from 'vue'
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

// 记录每个单元格 DOM，用于气泡锚定
const cellRefMap = reactive<Record<string, HTMLElement | null>>({})
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
import { nextTick, watch, ref as vRef, onMounted } from 'vue'
const rowsRoot = vRef<HTMLElement | null>(null)
const renderCountForBubbles = vRef(0)
onMounted(() => {
  setTimeout(() => (renderCountForBubbles.value = 1), 1000)
})
watch(
  () => props.songs.map((s) => s.filePath).join('|'),
  async () => {
    await nextTick()
    requestAnimationFrame(() => {
      try {
        const host = rowsRoot.value
        const count = host ? host.querySelectorAll('.song-row-item').length : 0
        emit('rows-rendered', count)
      } catch {
        emit('rows-rendered', 0)
      }
    })
  }
)

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
</script>

<template>
  <div
    ref="rowsRoot"
    @click="onRowsClick"
    @contextmenu.prevent="onRowsContextmenu"
    @dblclick="onRowsDblclick"
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
          >
            {{ song[col.key as keyof ISongInfo] }}
            <bubbleBox
              v-if="renderCountForBubbles"
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
