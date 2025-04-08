<script setup lang="ts">
import { computed, ref } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '../../components/rightClickMenu'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import emptyRecycleBin from '@renderer/assets/empty-recycleBin.png?asset'
import { handleLibraryAreaEmptySpaceDrop } from '@renderer/utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

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
const showHint = computed(() => {
  const children = libraryData.children
  const hasSpecialChild = children?.some((child) =>
    ['filterLibrarySonglistDemo1', 'curatedLibrarySonglistDemo1'].includes(child.uuid)
  )
  return !children?.length || (children?.length === 1 && hasSpecialChild)
})
let hoverTimer: NodeJS.Timeout
let collapseButtonHintShow = ref(false)
let emptyRecycleBinHintShow = ref(false)
const iconMouseover = (iconName: string) => {
  hoverTimer = setTimeout(() => {
    if (iconName == 'collapseButton') {
      collapseButtonHintShow.value = true
    } else if (iconName == 'emptyRecycleBin') {
      emptyRecycleBinHintShow.value = true
    }
  }, 500)
}
const iconMouseout = (iconName: string) => {
  clearTimeout(hoverTimer)
  if (iconName == 'collapseButton') {
    collapseButtonHintShow.value = false
  } else if (iconName == 'emptyRecycleBin') {
    emptyRecycleBinHintShow.value = false
  }
}

const emptyRecycleBinHandleClick = async () => {
  let res = await confirm({
    title: '清空回收站',
    content: [t('确认清空回收站吗？'), t('(曲目将在磁盘上被删除，但声音指纹依然会保留)')]
  })
  if (res !== 'confirm') {
    return
  }
  let recycleBinDirs = runtime.libraryTree.children?.find((item) => {
    return item.dirName === '回收站'
  })
  if (recycleBinDirs?.children?.length !== 0) {
    await window.electron.ipcRenderer.invoke('emptyRecycleBin')
    const recycleBin = runtime.libraryTree.children?.find((item) => item.dirName === '回收站')
    if (recycleBin) {
      recycleBin.children = []
    }
  }
}

const menuArr = ref([[{ menuName: '新建歌单' }, { menuName: '新建文件夹' }]])
const contextmenuEvent = async (event: MouseEvent) => {
  if (runtime.libraryAreaSelected === '回收站') {
    menuArr.value = [[{ menuName: '清空回收站' }]]
  } else {
    menuArr.value = [[{ menuName: '新建歌单' }, { menuName: '新建文件夹' }]]
  }
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (result.menuName == '新建歌单') {
      libraryData.children?.unshift({
        uuid: uuidV4(),
        type: 'songList',
        dirName: ''
      })
    } else if (result.menuName == '新建文件夹') {
      libraryData.children?.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    } else if (result.menuName == '清空回收站') {
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
  if (runtime.libraryAreaSelected === '回收站') {
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
  if (runtime.libraryAreaSelected === '回收站') {
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
  if (runtime.libraryAreaSelected === '回收站') {
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
  if (runtime.libraryAreaSelected === '回收站') {
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
      <span>{{ t(libraryData.dirName) }}</span>
      <!-- todo还有个导出整个库的按钮 -->
      <div style="display: flex; justify-content: center; align-items: center">
        <div
          class="collapseButton"
          @mouseover="iconMouseover('emptyRecycleBin')"
          @mouseout="iconMouseout('emptyRecycleBin')"
          v-show="runtime.libraryAreaSelected === '回收站'"
          @click="emptyRecycleBinHandleClick()"
        >
          <img :src="emptyRecycleBin" style="width: 16px; height: 16px" draggable="false" />
        </div>
        <div
          class="collapseButton"
          @mouseover="iconMouseover('collapseButton')"
          @mouseout="iconMouseout('collapseButton')"
          @click="collapseButtonHandleClick()"
        >
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
        <transition name="fade">
          <div
            class="bubbleBox"
            v-if="collapseButtonHintShow"
            style="position: absolute; top: 70px; z-index: 10"
          >
            {{ t('折叠文件夹') }}
          </div>
        </transition>
        <transition name="fade">
          <div
            class="bubbleBox"
            v-if="emptyRecycleBinHintShow"
            style="position: absolute; top: 70px; z-index: 10"
          >
            {{ t('清空回收站') }}
          </div>
        </transition>
      </div>
    </div>
    <div class="unselectable libraryArea">
      <OverlayScrollbarsComponent
        :options="{
          scrollbars: {
            autoHide: 'leave',
            autoHideDelay: 50,
            clickScroll: true
          },
          overflow: {
            x: 'hidden',
            y: 'scroll'
          }
        }"
        element="div"
        style="height: 100%; width: 100%"
        defer
      >
        <template v-for="item of libraryData.children" :key="item.uuid">
          <libraryItem
            :uuid="item.uuid"
            :libraryName="libraryData.dirName"
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
            {{ runtime.libraryAreaSelected === '回收站' ? t('暂无删除记录') : t('右键新建歌单') }}
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
      cursor: pointer;
      border-radius: 5px;

      &:hover {
        background-color: #2d2e2e;
      }
    }
  }
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
