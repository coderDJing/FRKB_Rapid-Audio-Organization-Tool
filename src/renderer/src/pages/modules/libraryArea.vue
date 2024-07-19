<script setup>
import { ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue'
import libraryItem from '@renderer/components/libraryItem.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils.js'
import { v4 as uuidv4 } from 'uuid'
import confirm from '@renderer/components/confirm.js'
const runtime = useRuntimeStore()
const props = defineProps({
  uuid: {
    type: String,
    required: true
  }
})
let libraryData = libraryUtils.getLibraryTreeByUUID(runtime.libraryTree, props.uuid)
let hoverTimer = null
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

const rightClickMenuShow = ref(false)
const clickEvent = ref({})
const menuArr = ref([[{ menuName: '新建歌单' }, { menuName: '新建文件夹' }]])
const contextmenuEvent = (event) => {
  clickEvent.value = event
  rightClickMenuShow.value = true
}

const menuButtonClick = async (item, e) => {
  if (item.menuName == '新建歌单') {
    libraryData.children.unshift({
      uuid: uuidv4(),
      type: 'songList',
      dirName: ''
    })
  } else if (item.menuName == '新建文件夹') {
    libraryData.children.unshift({
      uuid: uuidv4(),
      type: 'dir',
      dirName: ''
    })
  }
}

const collapseButtonHandleClick = async () => {
  window.electron.ipcRenderer.send('collapseButtonHandleClick', libraryData.dirName)
  console.log(runtime.libraryTree)
  console.log(JSON.stringify(runtime.libraryTree))
}

const dragApproach = ref('')
const dragover = (e) => {
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragenter = (e) => {
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragleave = (e) => {
  dragApproach.value = ''
}
const drop = async (e) => {
  dragApproach.value = ''
  let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(
    runtime.libraryTree,
    runtime.dragItemData.uuid
  )
  if (dragItemDataFather.uuid == props.uuid) {
    if (libraryData.children[libraryData.children.length - 1].uuid == runtime.dragItemData.uuid) {
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
      libraryUtils.findDirPathByUuid(runtime.libraryTree, libraryData.uuid),
      JSON.stringify(libraryData.children)
    )
    return
  } else {
    const existingItem = libraryData.children.find((item) => {
      return (
        item.dirName === runtime.dragItemData.dirName && item.uuid !== runtime.dragItemData.uuid
      )
    })
    if (existingItem) {
      let res = await confirm({
        title: '移动',
        content: [
          '目标文件夹下已存在："' + runtime.dragItemData.dirName + '"',
          '是否继续执行替换',
          '（被替换的歌单或文件夹将被删除）'
        ]
      })
      if (res == 'confirm') {
        let targetPath = libraryUtils.findDirPathByUuid(runtime.libraryTree, existingItem.uuid)
        await window.electron.ipcRenderer.invoke('delDir', targetPath)
        await window.electron.ipcRenderer.invoke(
          'moveToDirSample',
          libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.dragItemData.uuid),
          libraryUtils.findDirPathByUuid(runtime.libraryTree, libraryData.uuid)
        )
        libraryData.children.splice(libraryData.children.indexOf(existingItem), 1)
        let removedElement = dragItemDataFather.children.splice(
          dragItemDataFather.children.indexOf(runtime.dragItemData),
          1
        )[0]
        libraryUtils.reOrderChildren(dragItemDataFather.children)
        await window.electron.ipcRenderer.invoke(
          'reOrderSubDir',
          libraryUtils.findDirPathByUuid(runtime.libraryTree, dragItemDataFather.uuid),
          JSON.stringify(dragItemDataFather.children)
        )
        libraryData.children.push(removedElement)
        libraryUtils.reOrderChildren(libraryData.children)
        await window.electron.ipcRenderer.invoke(
          'reOrderSubDir',
          libraryUtils.findDirPathByUuid(runtime.libraryTree, libraryData.uuid),
          JSON.stringify(libraryData.children)
        )
      }
      return
    }
    await window.electron.ipcRenderer.invoke(
      'moveToDirSample',
      libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.dragItemData.uuid),
      libraryUtils.findDirPathByUuid(runtime.libraryTree, libraryData.uuid)
    )
    let removedElement = dragItemDataFather.children.splice(
      dragItemDataFather.children.indexOf(runtime.dragItemData),
      1
    )[0]
    libraryUtils.reOrderChildren(dragItemDataFather.children)
    await window.electron.ipcRenderer.invoke(
      'reOrderSubDir',
      libraryUtils.findDirPathByUuid(runtime.libraryTree, dragItemDataFather.uuid),
      JSON.stringify(dragItemDataFather.children)
    )
    libraryData.children.push(removedElement)
    libraryUtils.reOrderChildren(libraryData.children)
    await window.electron.ipcRenderer.invoke(
      'reOrderSubDir',
      libraryUtils.findDirPathByUuid(runtime.libraryTree, libraryData.uuid),
      JSON.stringify(libraryData.children)
    )
    return
  }
}
</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent">
    <div class="unselectable libraryTitle">
      <span>{{ libraryData.dirName }}</span>
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
            折叠文件夹
          </div>
        </transition>
      </div>
    </div>
    <div class="unselectable libraryArea" v-if="libraryData.children.length">
      <template v-for="item of libraryData.children" :key="item.uuid">
        <libraryItem
          :uuid="item.uuid"
          :libraryName="libraryData.dirName"
          v-if="!(runtime.selectSongListDialogShow && !item.dirName)"
        />
      </template>
      <div
        style="flex-grow: 1"
        @dragover.stop.prevent="dragover"
        @dragenter.stop.prevent="dragenter"
        @drop.stop="drop"
        @dragleave.stop="dragleave"
        :class="{ borderTop: dragApproach == 'top' }"
      ></div>
    </div>
    <div
      class="unselectable"
      v-else
      style="height: 100%; width: 100%; display: flex; justify-content: center; align-items: center"
    >
      <span style="font-size: 12px; color: #8c8c8c">右键新建歌单</span>
    </div>
  </div>
  <rightClickMenu
    v-model="rightClickMenuShow"
    :menuArr="menuArr"
    :clickEvent="clickEvent"
    @menuButtonClick="menuButtonClick"
  ></rightClickMenu>
</template>
<style lang="scss" scoped>
.borderTop {
  border-top: 1px solid #0078d4;
}

.libraryArea {
  height: calc(100% - 35px);
  max-height: calc(100% - 35px);
  width: 100%;
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
