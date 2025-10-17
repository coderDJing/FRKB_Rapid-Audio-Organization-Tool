<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '../../components/rightClickMenu'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import emptyRecycleBin from '@renderer/assets/empty-recycleBin.png?asset'
import { handleLibraryAreaEmptySpaceDrop } from '@renderer/utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'

const runtime = useRuntimeStore()
const props = defineProps({
  uuid: {
    type: String,
    required: true
  }
})
let libraryData = libraryUtils.getLibraryTreeByUUID(props.uuid)

if (libraryData === null) {
  throw new Error(`libraryData error: ${JSON.stringify(libraryData)}`)
}

const displayedChildren = computed(() => {
  if (runtime.libraryAreaSelected === 'RecycleBin' && libraryData.children) {
    // 创建一个倒序副本，不改变原数组
    return [...libraryData.children].reverse()
  }
  return libraryData.children
})

const showHint = computed(() => {
  const children = libraryData.children
  const hasSpecialChild = children?.some((child) =>
    ['filterLibrarySonglistDemo1', 'curatedLibrarySonglistDemo1'].includes(child.uuid)
  )
  return !children?.length || (children?.length === 1 && hasSpecialChild)
})
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const emptyRecycleRef = useTemplateRef<HTMLDivElement>('emptyRecycleRef')

// 将核心库名称映射为 i18n key，仅用于显示
const libraryTitleText = computed(() => toLibraryDisplayName(libraryData.dirName))

const emptyRecycleBinHandleClick = async () => {
  let res = await confirm({
    title: t('recycleBin.emptyRecycleBin'),
    content: [t('recycleBin.confirmEmpty'), t('tracks.deleteHint')]
  })
  if (res !== 'confirm') {
    return
  }
  const recycleBin = runtime.libraryTree.children?.find((item) => item.dirName === 'RecycleBin')
  const recycleChildren = recycleBin?.children || []
  if (recycleChildren.length === 0) return

  await window.electron.ipcRenderer.invoke('emptyRecycleBin')

  const recycleUUIDs = new Set(recycleChildren.map((c) => c.uuid))

  // 若当前打开的是回收站中的歌单，则关闭
  if (recycleUUIDs.has(runtime.songsArea.songListUUID)) {
    runtime.songsArea.songListUUID = ''
    runtime.songsArea.selectedSongFilePath.length = 0
    runtime.songsArea.songInfoArr = []
  }

  // 若当前正在播放来自回收站的歌单，则停止播放并清空播放列表
  if (recycleUUIDs.has(runtime.playingData.playingSongListUUID)) {
    runtime.playingData.playingSong = null
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
  }

  // 清空回收站 UI 节点
  if (recycleBin) {
    recycleBin.children = []
  }
}

// 歌单筛选关键词（仅匹配歌单名）
const playlistSearch = ref('')

const menuArr = ref([
  [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
])
const contextmenuEvent = async (event: MouseEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    menuArr.value = [[{ menuName: 'recycleBin.emptyRecycleBin' }]]
  } else {
    menuArr.value = [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]]
  }
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (result.menuName == 'library.createPlaylist') {
      const newUuid = uuidV4()
      libraryData.children?.unshift({
        uuid: newUuid,
        type: 'songList',
        dirName: ''
      })
      // 不在此时标记“创建中”，等待命名确认开始写盘时再标记
    } else if (result.menuName == 'library.createFolder') {
      libraryData.children?.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    } else if (result.menuName == 'recycleBin.emptyRecycleBin') {
      emptyRecycleBinHandleClick()
    }
  }
}

const collapseButtonHandleClick = async () => {
  emitter.emit('collapseButtonHandleClick', libraryData.dirName)
  console.log(JSON.parse(JSON.stringify(runtime.libraryTree)))
}

const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragenter = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragleave = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    return
  }
  if (runtime.dragItemData === null) {
    if (e.dataTransfer === null) {
      throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
    }
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  dragApproach.value = ''
}
const drop = async (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    runtime.dragItemData = null
    return
  }
  if (runtime.dragItemData === null) {
    if (e.dataTransfer === null) {
      throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
    }
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }

  dragApproach.value = ''

  try {
    // 使用 dragUtils 中的函数处理拖放到空白区域
    const handled = await handleLibraryAreaEmptySpaceDrop(runtime.dragItemData, libraryData)

    // 如果处理成功或失败，都清除拖拽数据
  } catch (error) {
    console.error('Drop operation failed:', error)
  } finally {
    runtime.dragItemData = null
  }
}
</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent">
    <div class="unselectable libraryTitle">
      <span>{{ libraryTitleText }}</span>
      <!-- todo还有个导出整个库的按钮 -->
      <div style="display: flex; justify-content: center; align-items: center">
        <div
          ref="emptyRecycleRef"
          class="collapseButton"
          v-show="runtime.libraryAreaSelected === 'RecycleBin'"
          @click="emptyRecycleBinHandleClick()"
        >
          <img :src="emptyRecycleBin" style="width: 16px; height: 16px" draggable="false" />
        </div>
        <div ref="collapseButtonRef" class="collapseButton" @click="collapseButtonHandleClick()">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
          >
            <path d="M9 9H4v1h5V9z" />
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"
            />
          </svg>
        </div>
        <bubbleBox :dom="collapseButtonRef || undefined" :title="t('playlist.collapsibleFolder')" />
        <bubbleBox :dom="emptyRecycleRef || undefined" :title="t('recycleBin.emptyRecycleBin')" />
      </div>
    </div>
    <!-- 顶部筛选输入框 -->
    <div class="librarySearchWrapper">
      <input
        v-model="playlistSearch"
        class="searchInput"
        :placeholder="t('playlist.searchPlaylists')"
      />
    </div>
    <div class="unselectable libraryArea">
      <OverlayScrollbarsComponent
        :options="{
          scrollbars: {
            autoHide: 'leave' as const,
            autoHideDelay: 50,
            clickScroll: true
          } as const,
          overflow: {
            x: 'hidden',
            y: 'scroll'
          } as const
        }"
        element="div"
        style="height: 100%; width: 100%"
        defer
      >
        <template v-for="item of displayedChildren" :key="item.uuid">
          <libraryItem
            :uuid="item.uuid"
            :libraryName="libraryData.dirName"
            :filterText="playlistSearch"
            v-if="!(runtime.selectSongListDialogShow && !item.dirName)"
          />
        </template>
        <div
          style="
            flex-grow: 1;
            min-height: 30px;
            display: flex;
            justify-content: center;
            align-items: center;
          "
          @dragover.stop.prevent="dragover"
          @dragenter.stop.prevent="dragenter"
          @drop.stop="drop"
          @dragleave.stop="dragleave"
          :class="{ borderTop: dragApproach == 'top' }"
        >
          <span
            style="font-size: 12px; color: #8c8c8c; position: absolute; bottom: 50vh"
            v-show="showHint && runtime.layoutConfig.libraryAreaWidth !== 0"
          >
            {{
              runtime.libraryAreaSelected === 'RecycleBin'
                ? t('recycleBin.noDeletionRecords')
                : t('library.rightClickToCreate')
            }}
          </span>
        </div>
      </OverlayScrollbarsComponent>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.borderTop {
  box-shadow: inset 0 1px 0 0 #0078d4;
}

.libraryArea {
  height: calc(100% - 35px);
  max-height: calc(100% - 35px);
  width: 100%;
  display: flex;
  flex-direction: column;
}

.content {
  height: 100%;
  width: 100%;
  display: flex;
  flex-grow: 1;
  background-color: #181818;
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    height: 35px;
    line-height: 35px;
    padding: 0 18px 0 20px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    justify-content: space-between;

    .collapseButton {
      color: #cccccc;
      width: 20px;
      height: 20px;
      display: flex;
      justify-content: center;
      align-items: center;

      border-radius: 5px;

      &:hover {
        background-color: #2d2e2e;
      }
    }
  }
}

.librarySearchWrapper {
  padding: 6px 5px 6px 5px;
  background-color: #181818;
}

.searchInput {
  width: 100%;
  height: 22px;
  line-height: 22px;
  background-color: #202020;
  border: 1px solid #424242;
  outline: none;
  color: #cccccc;
  border-radius: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: normal;
}

.bubbleBox {
  height: 22px;
  line-height: 22px;
  text-align: center;
  position: relative;
  border-radius: 3px;
  border: 1px solid #424242;
  font-size: 12px;
  background-color: #202020;
  padding: 0 10px;
  font-weight: normal;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
