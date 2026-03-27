<script setup lang="ts">
import { computed, ref, shallowRef, watch, useTemplateRef } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import { t } from '@renderer/utils/translate'
import { buildSongsAreaDefaultColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { getKeyDisplayText, getKeySortText } from '@shared/keyDisplay'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../types/globals'
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
const visibleSongs = ref<ISongInfo[]>([])
const loading = ref(false)
const selectedRowKeys = ref<string[]>([])
const columnData = ref<ISongsAreaColumn[]>(buildSongsAreaDefaultColumns('default'))

const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })

const selectedPlaylistId = computed(() => runtime.pioneerDeviceLibrary.selectedPlaylistId || 0)
const selectedDrivePath = computed(() => runtime.pioneerDeviceLibrary.selectedDrivePath || '')
const selectedPlaylistNode = computed(() => {
  const targetId = selectedPlaylistId.value
  if (!targetId) return null
  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode | null => {
    for (const item of items) {
      if (item.id === targetId) return item
      if (Array.isArray(item.children) && item.children.length > 0) {
        const found = walk(item.children)
        if (found) return found
      }
    }
    return null
  }
  return walk(runtime.pioneerDeviceLibrary.treeNodes || [])
})

const visibleColumns = computed(() => columnData.value.filter((item) => item.show))
const totalWidth = computed(() =>
  visibleColumns.value.reduce((sum, col) => sum + Number(col.width || 0), 0)
)

const toSongInfo = (track: IPioneerPlaylistTrack): ISongInfo => ({
  filePath: track.filePath,
  fileName: track.fileName,
  fileFormat: track.fileFormat,
  cover: null,
  title: track.title,
  artist: track.artist || undefined,
  album: track.album || undefined,
  duration: track.duration,
  genre: track.genre || undefined,
  label: track.label || undefined,
  bitrate: track.bitrate,
  container: track.container || undefined,
  key: track.key,
  bpm: track.bpm,
  mixOrder: track.entryIndex,
  pioneerCoverPath: track.coverPath || null,
  pioneerAnalyzePath: track.analyzePath || null,
  mixtapeItemId: track.rowKey
})

const sortArrayByProperty = <T extends Record<string, any>>(
  array: T[],
  property: keyof T,
  order: 'asc' | 'desc'
) => {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  return [...array].sort((a, b) => {
    const valueA = String(a[property] || '')
    const valueB = String(b[property] || '')
    return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
  })
}

const parseDurationToSeconds = (mmss: string): number => {
  if (!mmss || typeof mmss !== 'string') return NaN
  const parts = mmss.split(':')
  if (parts.length !== 2) return NaN
  const minutes = Number(parts[0])
  const seconds = Number(parts[1])
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return NaN
  return minutes * 60 + seconds
}

const parseNumberInput = (input: unknown): number => {
  if (input === null || input === undefined) return NaN
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN
  const raw = String(input || '').trim()
  if (!raw) return NaN
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return NaN
  const parts = cleaned.split('.')
  const normalized = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
  const value = Number(normalized)
  return Number.isFinite(value) ? value : NaN
}

const parseExcludeKeywords = (input: unknown): string[] => {
  if (input === null || input === undefined) return []
  const raw = String(input)
  if (!raw.trim()) return []
  return raw
    .split(/[,\n;\r，；、|]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

const applyFiltersAndSorting = () => {
  let filtered = originalTracks.value.map((track) => toSongInfo(track))
  for (const col of columnData.value) {
    if (!col.filterActive) continue
    if (col.filterType === 'text' && col.key) {
      const keyword = String(col.filterValue || '').toLowerCase()
      const excludeKeywords = parseExcludeKeywords(col.filterExcludeValue)
      const hasInclude = keyword.trim().length > 0
      const hasExclude = excludeKeywords.length > 0
      if (!hasInclude && !hasExclude) continue
      const isKeyColumn = col.key === 'key'
      const keyStyle =
        (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
      filtered = filtered.filter((song) => {
        const rawValue = String((song as any)[col.key] ?? '')
        const displayValue = isKeyColumn ? getKeyDisplayText(rawValue, keyStyle) : rawValue
        const value = displayValue.toLowerCase()
        if (hasInclude && !value.includes(keyword)) return false
        if (hasExclude && excludeKeywords.some((item) => value.includes(item))) return false
        return true
      })
    } else if (col.filterType === 'duration' && col.filterOp && col.filterDuration) {
      const target = parseDurationToSeconds(col.filterDuration)
      filtered = filtered.filter((song) => {
        const duration = parseDurationToSeconds(String((song as any).duration ?? ''))
        if (Number.isNaN(duration) || Number.isNaN(target)) return false
        if (col.filterOp === 'eq') return duration === target
        if (col.filterOp === 'gte') return duration >= target
        if (col.filterOp === 'lte') return duration <= target
        return true
      })
    } else if (col.filterType === 'bpm' && col.filterOp && col.filterNumber) {
      const target = parseNumberInput(col.filterNumber)
      filtered = filtered.filter((song) => {
        const bpm = parseNumberInput((song as any)?.bpm)
        if (Number.isNaN(bpm) || Number.isNaN(target)) return false
        if (col.filterOp === 'eq') return bpm === target
        if (col.filterOp === 'gte') return bpm >= target
        if (col.filterOp === 'lte') return bpm <= target
        return true
      })
    }
  }

  const sortedCol = columnData.value.find((col) => col.order)
  if (sortedCol) {
    if (sortedCol.key === 'index') {
      filtered = [...filtered].sort((a, b) => {
        const valueA = Number(a.mixOrder) || 0
        const valueB = Number(b.mixOrder) || 0
        return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
      })
    } else if (sortedCol.key === 'key') {
      const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
      const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
      filtered = [...filtered].sort((a, b) => {
        const valueA = getKeySortText(String((a as any).key || ''), style)
        const valueB = getKeySortText(String((b as any).key || ''), style)
        return sortedCol.order === 'asc'
          ? collator.compare(valueA, valueB)
          : collator.compare(valueB, valueA)
      })
    } else {
      filtered = sortArrayByProperty(
        filtered as any[],
        sortedCol.key as keyof ISongInfo,
        sortedCol.order!
      )
    }
  }

  visibleSongs.value = filtered
}

const handleColumnsUpdate = (nextColumns: ISongsAreaColumn[]) => {
  columnData.value = nextColumns
  applyFiltersAndSorting()
  selectedRowKeys.value = []
}

const handleColumnClick = (column: ISongsAreaColumn) => {
  if (column.key === 'cover' || column.key === 'waveformPreview') return
  columnData.value = columnData.value.map((item) => {
    if (item.key !== column.key) return { ...item, order: undefined }
    const nextOrder = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
    return { ...item, order: nextOrder as 'asc' | 'desc' }
  })
  applyFiltersAndSorting()
}

const loadPlaylistTracks = async () => {
  if (!selectedDrivePath.value || !selectedPlaylistId.value) {
    originalTracks.value = []
    visibleSongs.value = []
    selectedRowKeys.value = []
    return
  }
  loading.value = true
  selectedRowKeys.value = []
  try {
    const result = await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:load-playlist-tracks',
      selectedDrivePath.value,
      selectedPlaylistId.value
    )
    originalTracks.value = Array.isArray(result?.tracks) ? result.tracks : []
    applyFiltersAndSorting()
  } catch (error) {
    console.error('[pioneerSongsArea] load playlist tracks failed', error)
    originalTracks.value = []
    visibleSongs.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [selectedDrivePath.value, selectedPlaylistId.value] as const,
  () => {
    void loadPlaylistTracks()
  },
  { immediate: true }
)

watch(
  () => runtime.setting.keyDisplayStyle,
  () => {
    applyFiltersAndSorting()
  }
)

const handleSongClick = (event: MouseEvent, song: ISongInfo) => {
  const key = song.mixtapeItemId || song.filePath
  if (!key) return
  selectedRowKeys.value = [key]
}

const placeholderText = computed(() => {
  if (loading.value) return '正在读取 Pioneer 歌单内容...'
  if (!selectedPlaylistId.value) return '先在左侧选择一个 Pioneer 歌单。'
  if (!visibleSongs.value.length) return '这个歌单里暂时没有可显示的曲目。'
  return ''
})
</script>

<template>
  <div class="songsAreaShell">
    <div v-if="placeholderText" class="songsAreaPlaceholder">
      {{ placeholderText }}
    </div>
    <OverlayScrollbarsComponent
      v-else
      ref="songsAreaRef"
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
      style="height: 100%; width: 100%; position: relative"
      defer
      @click="selectedRowKeys = []"
    >
      <SongListHeader
        :columns="columnData"
        :t="t"
        :ascending-order="ascendingOrder"
        :descending-order="descendingOrder"
        :total-width="totalWidth"
        @update:columns="handleColumnsUpdate"
        @column-click="handleColumnClick"
        @header-contextmenu.stop.prevent
      />

      <SongListRows
        :songs="visibleSongs"
        :visible-columns="visibleColumns"
        :selected-song-file-paths="selectedRowKeys"
        :playing-song-file-path="''"
        :flash-row-key="''"
        :flash-row-token="0"
        :total-width="totalWidth"
        source-library-name="PioneerDeviceLibrary"
        :source-song-list-u-u-i-d="`pioneer:${selectedPlaylistId}`"
        :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
        :external-scroll-top="externalScrollTop"
        :external-viewport-height="externalViewportHeight"
        :pioneer-device-root-path="selectedDrivePath"
        :read-only="true"
        :enable-cover-thumbnails="true"
        :enable-key-analysis-queue="false"
        @song-click="handleSongClick"
      />
    </OverlayScrollbarsComponent>
  </div>
</template>

<style scoped lang="scss">
.songsAreaShell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.songsAreaHeader {
  flex: 0 0 auto;
}

.songsAreaBody {
  flex: 1 1 auto;
  min-height: 0;
}

.songsAreaPlaceholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 12px;
}
</style>
