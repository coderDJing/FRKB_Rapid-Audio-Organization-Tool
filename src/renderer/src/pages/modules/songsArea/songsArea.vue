<script setup lang="ts">
import { ref, shallowRef, computed, useTemplateRef } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'

// 组件导入
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import welcomePage from '@renderer/components/welcomePage.vue'
import SongListHeader from './SongListHeader.vue'
import SongListRows from './SongListRows.vue'
import ColumnHeaderContextMenu from './ColumnHeaderContextMenu.vue'

// Composable import
import { useSongItemContextMenu } from '@renderer/pages/modules/songsArea/composables/useSongItemContextMenu'
import { useSelectAndMoveSongs } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import { useSongsAreaColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { useSongsLoader } from '@renderer/pages/modules/songsArea/composables/useSongsLoader'
import { useSweepCovers } from '@renderer/pages/modules/songsArea/composables/useSweepCovers'
import { useKeyboardSelection } from '@renderer/pages/modules/songsArea/composables/useKeyboardSelection'
import { useAutoScrollToCurrent } from '@renderer/pages/modules/songsArea/composables/useAutoScrollToCurrent'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import { useSongsAreaEvents } from '@renderer/pages/modules/songsArea/composables/useSongsAreaEvents'

// 资源导入
import ascendingOrder from '@renderer/assets/ascending-order.png?asset'
import descendingOrder from '@renderer/assets/descending-order.png?asset'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，以便正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
// 使用浅响应+markRaw，避免为上千行数据创建深层 Proxy，降低 flushJobs 峰值
const originalSongInfoArr = shallowRef<ISongInfo[]>([])

// 父级滚动采样
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })

// Initialize composables
const { showAndHandleSongContextMenu } = useSongItemContextMenu(songsAreaRef)
const {
  isDialogVisible: isSelectSongListDialogVisible,
  targetLibraryName: selectSongListDialogTargetLibraryName,
  initiateMoveSongs,
  handleMoveSongsConfirm,
  handleDialogCancel
} = useSelectAndMoveSongs()
const { isDragging, startDragSongs, endDragSongs, handleDropToSongList } = useDragSongs()

// 集中列、筛选、排序与列头交互逻辑
const {
  columnData,
  columnDataArr,
  totalColumnsWidth,
  colRightClickMenuShow,
  triggeringColContextEvent,
  contextmenuEvent,
  handleToggleColumnVisibility,
  handleColumnsUpdate,
  colMenuClick,
  applyFiltersAndSorting
} = useSongsAreaColumns({ runtime, originalSongInfoArr })

// 封面清理
const { scheduleSweepCovers } = useSweepCovers({ runtime })

// 歌曲加载与渐进渲染
const { loadingShow, isRequesting, openSongList } = useSongsLoader({
  runtime,
  originalSongInfoArr,
  applyFiltersAndSorting
})

// 键盘与鼠标选择
const { songClick } = useKeyboardSelection({
  runtime,
  externalViewportHeight,
  scheduleSweepCovers
})

// 自动滚动到当前播放
useAutoScrollToCurrent({ runtime, songsAreaRef })

// 事件订阅与同步
useSongsAreaEvents({
  runtime,
  originalSongInfoArr,
  applyFiltersAndSorting,
  openSongList,
  scheduleSweepCovers
})
// 上述列、加载、事件与封面清理已由组合函数提供

// 移除残留的 perfLog

// songClick 已由 useKeyboardSelection 提供

const handleSongContextMenuEvent = async (event: MouseEvent, song: ISongInfo) => {
  const result = await showAndHandleSongContextMenu(event, song)
  if (result) {
    // 处理移动歌曲到其他列表的对话框请求
    if (result.action === 'openSelectSongListDialog') {
      // result 类型符合 OpenDialogAction 接口
      initiateMoveSongs(result.libraryName)
    }
    // 处理来自右键菜单的歌曲移除操作 (删除、导出后删除等)
    else if (result.action === 'songsRemoved') {
      const pathsToRemove = result.paths

      if (Array.isArray(pathsToRemove) && pathsToRemove.length > 0) {
        // 仅更新 original，然后统一按筛选与排序重建显示，避免与排序/筛选链路打架
        originalSongInfoArr.value = originalSongInfoArr.value.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )

        applyFiltersAndSorting()

        // 更新播放状态（若受影响）
        if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
          runtime.playingData.playingSongListData = [...runtime.songsArea.songInfoArr]
        }
        if (
          runtime.playingData.playingSong &&
          pathsToRemove.includes(runtime.playingData.playingSong.filePath)
        ) {
          runtime.playingData.playingSong = null
        }

        // 从当前选择中移除已删除的歌曲
        runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
          (path) => !pathsToRemove.includes(path)
        )
      }
    }
    // 其他可能的 action 处理...
  }
  // 如果 result 是 null，或者 action 不匹配任何已知处理，则不执行任何操作
}

const songDblClick = async (song: ISongInfo) => {
  const lower = (song.filePath || '').toLowerCase()
  if (lower.endsWith('.aif') || lower.endsWith('.aiff')) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('player.aiffNotSupported')],
      confirmShow: false
    })
    return
  }

  runtime.activeMenuUUID = ''
  runtime.songsArea.selectedSongFilePath = []
  runtime.playingData.playingSong = song
  runtime.playingData.playingSongListUUID = runtime.songsArea.songListUUID
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
}
// 删除键处理由 useKeyboardSelection 绑定

// 键盘 Shift 范围选择与快捷键绑定由 useKeyboardSelection 管理

// 排序、筛选与列点击等逻辑由 useSongsAreaColumns 提供

// --- 新增计算属性给 SongListRows ---
const playingSongFilePathForRows = computed(() => runtime.playingData.playingSong?.filePath)

// 父级采样由 useParentRafSampler 提供

// 自动滚动逻辑由 useAutoScrollToCurrent 提供

// 新增：处理移动歌曲对话框确认后的逻辑
async function onMoveSongsDialogConfirmed(targetSongListUuid: string) {
  const pathsEffectivelyMoved = [...runtime.songsArea.selectedSongFilePath]

  if (pathsEffectivelyMoved.length === 0) {
    // 如果没有选中的歌曲，让 composable 的 handleMoveSongsConfirm 处理（它可能会直接关闭对话框或不做任何事）
    await handleMoveSongsConfirm(targetSongListUuid)
    return
  }

  // 调用 composable 中的函数来执行移动操作 (IPC, 关闭对话框, 清空选择等)
  // handleMoveSongsConfirm 应该会处理 isDialogVisible 和 selectedSongFilePath
  await handleMoveSongsConfirm(targetSongListUuid)
  // 不在此处直接重建 original/runtime，避免与全局 events（songsRemoved）重复或打架导致“复活”
  // 仅记录日志，列表更新完全交给事件流处理
  // runtime.songsArea.selectedSongFilePath 应该已经被 handleMoveSongsConfirm (composable内部) 清空了
}

const shouldShowEmptyState = computed(() => {
  return (
    !isRequesting.value &&
    runtime.songsArea.songListUUID &&
    runtime.songsArea.songInfoArr.length === 0
  )
})
// 是否存在任意激活的筛选条件
const hasActiveFilter = computed(() => columnData.value.some((c) => !!c.filterActive))
// --- END 新增计算属性 ---

// 拖拽相关函数
const handleSongDragStart = (event: DragEvent, song: ISongInfo) => {
  if (!runtime.songsArea.songListUUID) return

  // 确保拖拽的歌曲在选中列表中
  const isSelected = runtime.songsArea.selectedSongFilePath.includes(song.filePath)

  if (!isSelected || runtime.songsArea.selectedSongFilePath.length === 0) {
    // 如果这首歌没有被选中，或者没有选中任何歌曲，就选中这首歌
    runtime.songsArea.selectedSongFilePath = [song.filePath]
  }

  startDragSongs(song, runtime.libraryAreaSelected, runtime.songsArea.songListUUID)

  // 设置拖拽数据
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      'application/x-song-drag',
      JSON.stringify({
        type: 'song',
        sourceLibraryName: runtime.libraryAreaSelected,
        sourceSongListUUID: runtime.songsArea.songListUUID
      })
    )
  }
}

const handleSongDragEnd = (event: DragEvent) => {
  endDragSongs()
}

// 播放列表同步由 useSongsAreaEvents 管理
</script>
<template>
  <div style="width: 100%; height: 100%; min-width: 0; overflow: hidden; position: relative">
    <div
      v-show="!loadingShow && !runtime.songsArea.songListUUID"
      class="unselectable welcomeContainer"
    >
      <welcomePage />
    </div>
    <div
      v-show="loadingShow"
      style="width: 100%; height: 100%; display: flex; justify-content: center; align-items: center"
    >
      <div class="loading"></div>
    </div>

    <OverlayScrollbarsComponent
      v-if="runtime.songsArea.songListUUID && !loadingShow"
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
      ref="songsAreaRef"
      @click="runtime.songsArea.selectedSongFilePath.length = 0"
    >
      <SongListHeader
        :columns="columnData"
        :t="t"
        :ascendingOrder="ascendingOrder"
        :descendingOrder="descendingOrder"
        :total-width="totalColumnsWidth"
        @update:columns="handleColumnsUpdate"
        @column-click="colMenuClick"
        @header-contextmenu="contextmenuEvent"
        @drag-start="runtime.dragTableHeader = true"
        @drag-end="runtime.dragTableHeader = false"
      />

      <!-- 使用 SongListRows 组件渲染歌曲列表 -->
      <SongListRows
        v-if="runtime.songsArea.songInfoArr.length > 0"
        :songs="runtime.songsArea.songInfoArr"
        :visibleColumns="columnDataArr"
        :selectedSongFilePaths="runtime.songsArea.selectedSongFilePath"
        :playingSongFilePath="playingSongFilePathForRows"
        :total-width="totalColumnsWidth"
        :sourceLibraryName="runtime.libraryAreaSelected"
        :sourceSongListUUID="runtime.songsArea.songListUUID"
        :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
        :external-scroll-top="externalScrollTop"
        :external-viewport-height="externalViewportHeight"
        :song-list-root-dir="libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID) || ''"
        @song-click="songClick"
        @song-contextmenu="handleSongContextMenuEvent"
        @song-dblclick="songDblClick"
        @song-dragstart="handleSongDragStart"
        @song-dragend="handleSongDragEnd"
      />
    </OverlayScrollbarsComponent>

    <!-- Empty State Overlay: 独立于滚动内容，始终居中在可视区域 -->
    <div v-if="shouldShowEmptyState && !loadingShow" class="songs-area-empty-overlay unselectable">
      <div class="empty-box">
        <div class="title">
          {{ hasActiveFilter ? t('filters.noResults') : t('tracks.noTracks') }}
        </div>
        <div class="hint">
          {{ hasActiveFilter ? t('filters.noResultsHint') : t('tracks.noTracksHint') }}
        </div>
      </div>
    </div>

    <ColumnHeaderContextMenu
      v-model="colRightClickMenuShow"
      :targetEvent="triggeringColContextEvent"
      :columns="columnData"
      :scrollHostElement="songsAreaRef?.osInstance()?.elements().host"
      @toggle-column-visibility="handleToggleColumnVisibility"
    />
    <Teleport to="body">
      <selectSongListDialog
        v-if="isSelectSongListDialogVisible"
        :libraryName="selectSongListDialogTargetLibraryName"
        @confirm="onMoveSongsDialogConfirmed"
        @cancel="handleDialogCancel"
      />
    </Teleport>
  </div>
</template>
<style lang="scss" scoped>
.loading {
  display: block;
  position: relative;
  width: 6px;
  height: 10px;

  animation: rectangle infinite 1s ease-in-out -0.2s;

  background-color: #cccccc;
}

.loading:before,
.loading:after {
  position: absolute;
  width: 6px;
  height: 10px;
  content: '';
  background-color: #cccccc;
}

.loading:before {
  left: -14px;

  animation: rectangle infinite 1s ease-in-out -0.4s;
}

.loading:after {
  right: -14px;

  animation: rectangle infinite 1s ease-in-out;
}

@keyframes rectangle {
  0%,
  80%,
  100% {
    height: 20px;
    box-shadow: 0 0 #cccccc;
  }

  40% {
    height: 30px;
    box-shadow: 0 -20px #cccccc;
  }
}

.welcomeContainer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 430px;
}

/* 为新的空状态容器添加一个类名，以便将来可能需要的特定样式 */
.songs-area-empty-state {
  /* Styles for empty state are mostly inline, but class is good for targeting */
  &.unselectable {
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
  }
}

/* 新的空态覆盖层，固定在可视区域中央，不受横向滚动影响 */
.songs-area-empty-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.songs-area-empty-overlay .empty-box {
  min-height: 120px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.songs-area-empty-overlay .title {
  font-size: 16px;
  color: #999999;
}
.songs-area-empty-overlay .hint {
  font-size: 12px;
  color: #999999;
  margin-top: 10px;
}
</style>
