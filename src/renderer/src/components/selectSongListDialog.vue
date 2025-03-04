<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import hotkeys from 'hotkeys-js'
import listIcon from '@renderer/assets/listIcon.png?asset'
import utils, { getCurrentTimeDirName } from '../utils/utils'
import { t } from '@renderer/utils/translate'
import emitter from '../utils/mitt'
import type { IDir } from 'src/types/globals'
const uuid = uuidV4()
const props = defineProps({
  libraryName: {
    type: String,
    default: '筛选库'
  }
})

const runtime = useRuntimeStore()
runtime.activeMenuUUID = ''
runtime.selectSongListDialogShow = true
let recentDialogSelectedSongListUUID: string[] = []
let localStorageRecentDialogSelectedSongListUUID = localStorage.getItem(
  'recentDialogSelectedSongListUUID' + props.libraryName
)
if (localStorageRecentDialogSelectedSongListUUID) {
  recentDialogSelectedSongListUUID = JSON.parse(localStorageRecentDialogSelectedSongListUUID)
}
let index = 0
if (recentDialogSelectedSongListUUID.length !== 0) {
  runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
}

const recentSongListArr = ref<IDir[]>([])
let delRecentDialogSelectedSongListUUID: string[] = []
watch(
  () => runtime.libraryTree,
  () => {
    recentSongListArr.value = []
    delRecentDialogSelectedSongListUUID = []
    for (let uuid of recentDialogSelectedSongListUUID) {
      let obj = libraryUtils.getLibraryTreeByUUID(uuid)
      if (obj === null) {
        delRecentDialogSelectedSongListUUID.push(uuid)
      }
      if (obj) {
        recentSongListArr.value.push(obj)
      }
    }
    if (delRecentDialogSelectedSongListUUID.length !== 0) {
      recentDialogSelectedSongListUUID = recentDialogSelectedSongListUUID.filter(
        (item) => delRecentDialogSelectedSongListUUID.indexOf(item) === -1
      )
      localStorage.setItem(
        'recentDialogSelectedSongListUUID' + props.libraryName,
        JSON.stringify(recentDialogSelectedSongListUUID)
      )
    }
  },
  { deep: true, immediate: true }
)

let filtrateLibraryUUID: string | undefined
if (runtime.libraryTree && runtime.libraryTree.children) {
  filtrateLibraryUUID = runtime.libraryTree.children.find(
    (element) => element.type === 'library' && element.dirName === props.libraryName
  )?.uuid
}
if (filtrateLibraryUUID === undefined) {
  throw new Error(`filtrateLibraryUUID error: ${JSON.stringify(filtrateLibraryUUID)}`)
}
let libraryData = libraryUtils.getLibraryTreeByUUID(filtrateLibraryUUID)
if (libraryData === null) {
  throw new Error(`libraryData error: ${JSON.stringify(libraryData)}`)
}
let hoverTimer: NodeJS.Timeout
let collapseButtonHintShow = ref(false)
const iconMouseover = () => {
  hoverTimer = setTimeout(() => {
    collapseButtonHintShow.value = true
  }, 500)
}
const iconMouseout = () => {
  clearTimeout(hoverTimer)
  collapseButtonHintShow.value = false
}

const menuArr = ref([[{ menuName: '新建歌单' }, { menuName: '新建文件夹' }]])
const contextmenuEvent = async (event: MouseEvent) => {
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
    }
  }
}

const collapseButtonHandleClick = async () => {
  emitter.emit('collapseButtonHandleClick', libraryData.dirName + 'Dialog')
}

const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragenter = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragleave = () => {
  if (runtime.dragItemData === null) {
    return
  }
  dragApproach.value = ''
}
const drop = async () => {
  dragApproach.value = ''
  if (runtime.dragItemData === null) {
    return
  }
  try {
    let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
    if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
      throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
    }
    if (libraryData.children === undefined) {
      throw new Error(`libraryData.children error: ${JSON.stringify(libraryData.children)}`)
    }

    // 检查源文件是否存在
    let sourcePath = libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid)
    let isSourcePathExist = await window.electron.ipcRenderer.invoke('dirPathExists', sourcePath)
    if (!isSourcePathExist) {
      runtime.dragItemData = null
      await confirm({
        title: '错误',
        content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
        confirmShow: false
      })
      return
    }

    if (dragItemDataFather.uuid == filtrateLibraryUUID) {
      if (libraryData.children[libraryData.children.length - 1].uuid == runtime.dragItemData.uuid) {
        runtime.dragItemData = null
        return
      }
      //同一层级仅调换位置
      let removedElement = libraryData.children.splice(
        libraryData.children.indexOf(runtime.dragItemData),
        1
      )[0]
      libraryData.children.push(removedElement)
      libraryUtils.reOrderChildren(libraryData.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(libraryData.uuid),
        JSON.stringify(libraryData.children)
      )
      runtime.dragItemData = null
      return
    } else {
      const existingItem = libraryData.children.find((item) => {
        return (
          item.dirName === runtime.dragItemData?.dirName && item.uuid !== runtime.dragItemData.uuid
        )
      })
      if (existingItem) {
        let res = await confirm({
          title: '移动',
          content: [
            t('目标文件夹下已存在："') + runtime.dragItemData.dirName + t('"'),
            t('是否继续执行替换'),
            t('（被替换的歌单或文件夹将被删除）')
          ]
        })
        if (res == 'confirm') {
          let targetPath = libraryUtils.findDirPathByUuid(existingItem.uuid)
          await window.electron.ipcRenderer.invoke('delDir', targetPath, getCurrentTimeDirName())
          await window.electron.ipcRenderer.invoke(
            'moveToDirSample',
            libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid),
            libraryUtils.findDirPathByUuid(libraryData.uuid)
          )
          libraryData.children.splice(libraryData.children.indexOf(existingItem), 1)
          let removedElement = dragItemDataFather.children.splice(
            dragItemDataFather.children.indexOf(runtime.dragItemData),
            1
          )[0]
          libraryUtils.reOrderChildren(dragItemDataFather.children)
          await window.electron.ipcRenderer.invoke(
            'reOrderSubDir',
            libraryUtils.findDirPathByUuid(dragItemDataFather.uuid),
            JSON.stringify(dragItemDataFather.children)
          )
          libraryData.children.push(removedElement)
          libraryUtils.reOrderChildren(libraryData.children)
          await window.electron.ipcRenderer.invoke(
            'reOrderSubDir',
            libraryUtils.findDirPathByUuid(libraryData.uuid),
            JSON.stringify(libraryData.children)
          )
        }
        runtime.dragItemData = null
        return
      }
      await window.electron.ipcRenderer.invoke(
        'moveToDirSample',
        libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid),
        libraryUtils.findDirPathByUuid(libraryData.uuid)
      )
      let removedElement = dragItemDataFather.children.splice(
        dragItemDataFather.children.indexOf(runtime.dragItemData),
        1
      )[0]
      libraryUtils.reOrderChildren(dragItemDataFather.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(dragItemDataFather.uuid),
        JSON.stringify(dragItemDataFather.children)
      )
      libraryData.children.push(removedElement)
      libraryUtils.reOrderChildren(libraryData.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(libraryData.uuid),
        JSON.stringify(libraryData.children)
      )
      runtime.dragItemData = null
      return
    }
  } catch (error) {
    runtime.dragItemData = null
  }
}
onMounted(() => {
  hotkeys('s', uuid, () => {
    if (recentDialogSelectedSongListUUID.length !== 0) {
      index++
      if (index === recentDialogSelectedSongListUUID.length) {
        index = 0
      }
      runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
    }
  })
  hotkeys('w', uuid, () => {
    if (recentDialogSelectedSongListUUID.length !== 0) {
      index--
      if (index === -1) {
        index = recentDialogSelectedSongListUUID.length - 1
      }
      runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
    }
  })
  hotkeys('E', uuid, () => {
    confirmHandle()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.dialogSelectedSongListUUID = ''
  runtime.selectSongListDialogShow = false
})

const flashArea = ref('') // 控制动画是否正在播放
// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = '' // 动画结束，不再闪烁
    }
  }, 500) // 每次闪烁间隔 500 毫秒
}
const confirmHandle = () => {
  if (
    runtime.dialogSelectedSongListUUID === '' ||
    libraryUtils.getLibraryTreeByUUID(runtime.dialogSelectedSongListUUID) === null
  ) {
    if (!flashArea.value) {
      flashBorder('selectSongList')
    }
  } else {
    if (recentDialogSelectedSongListUUID.indexOf(runtime.dialogSelectedSongListUUID) === -1) {
      recentDialogSelectedSongListUUID.unshift(runtime.dialogSelectedSongListUUID)
      if (recentDialogSelectedSongListUUID.length > 10) {
        recentDialogSelectedSongListUUID.pop()
      }
    } else {
      recentDialogSelectedSongListUUID.unshift(
        recentDialogSelectedSongListUUID.splice(
          recentDialogSelectedSongListUUID.indexOf(runtime.dialogSelectedSongListUUID),
          1
        )[0]
      )
    }
    localStorage.setItem(
      'recentDialogSelectedSongListUUID' + props.libraryName,
      JSON.stringify(recentDialogSelectedSongListUUID)
    )
    emits('confirm', runtime.dialogSelectedSongListUUID)
  }
}
const emits = defineEmits(['cancel', 'confirm'])
const cancel = () => {
  emits('cancel')
}
</script>
<template>
  <div class="dialog unselectable">
    <div class="content inner" @contextmenu.stop="contextmenuEvent">
      <div class="unselectable libraryTitle">
        <span>{{ t(libraryData.dirName) }}</span>
        <div style="display: flex; justify-content: center; align-items: center">
          <div
            class="collapseButton"
            @mouseover="iconMouseover()"
            @mouseout="iconMouseout()"
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
              style="position: absolute; top: 70px"
            >
              {{ t('折叠文件夹') }}
            </div>
          </transition>
        </div>
      </div>
      <div
        class="unselectable libraryArea flashing-border"
        :class="{ 'is-flashing': flashArea == 'selectSongList' }"
        v-if="libraryData.children?.length"
      >
        <template v-if="recentSongListArr.length > 0">
          <div style="padding-left: 5px">
            <span style="font-size: 14px">{{ t('最近使用') }}</span>
          </div>
          <div style="width: 100%; background-color: #8c8c8c; height: 1px">
            <div style="height: 1px"></div>
          </div>
          <div
            v-for="item of recentSongListArr"
            :key="item.uuid"
            @click="runtime.dialogSelectedSongListUUID = item.uuid"
            @dblclick="confirmHandle()"
            :class="{ selectedDir: item.uuid == runtime.dialogSelectedSongListUUID }"
            class="recentLibraryItem"
          >
            <div style="width: 20px; justify-content: center; align-items: center; display: flex">
              <img style="width: 13px; height: 13px" :src="listIcon" />
            </div>
            <div>
              {{ item.dirName }}
            </div>
          </div>
          <div style="width: 100%; background-color: #8c8c8c; height: 1px">
            <div style="height: 1px"></div>
          </div>
        </template>
        <template v-for="item of libraryData.children" :key="item.uuid">
          <dialogLibraryItem
            :uuid="item.uuid"
            :libraryName="libraryData.dirName + 'Dialog'"
            @dblClickSongList="confirmHandle()"
          />
        </template>
        <div
          style="flex-grow: 1; min-height: 30px"
          @dragover.stop.prevent="dragover"
          @dragenter.stop.prevent="dragenter"
          @drop.stop="drop"
          @dragleave.stop="dragleave"
          :class="{ borderTop: dragApproach == 'top' }"
        ></div>
      </div>
      <div
        class="unselectable flashing-border"
        :class="{ 'is-flashing': flashArea == 'selectSongList' }"
        v-else
        style="
          height: 100%;
          max-width: 300px;
          display: flex;
          justify-content: center;
          align-items: center;
        "
      >
        <span style="font-size: 12px; color: #8c8c8c">{{ t('右键新建歌单') }}</span>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirmHandle()"
        >
          {{ t('确定') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('取消') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.recentLibraryItem {
  display: flex;
  cursor: pointer;
  height: 23px;
  align-items: center;
  font-size: 13px;

  &:hover {
    background-color: #2a2d2e;
  }
}

.selectedDir {
  background-color: #37373d;

  &:hover {
    background-color: #37373d !important;
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 #0078d4;
}

.libraryArea {
  height: 500px;
  max-width: 300px;
  overflow-y: hidden;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;

  &:hover {
    overflow-y: auto;
  }
}

.content {
  height: 500px;
  width: 300px;
  max-width: 300px;
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
