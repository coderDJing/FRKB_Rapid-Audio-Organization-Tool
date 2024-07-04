<script setup>
import { ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue';
import libraryItem from '@renderer/components/libraryItem.vue';
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils.js'
import { v4 as uuidv4 } from 'uuid';
const runtime = useRuntimeStore()
const props = defineProps(
  {
    uuid: {
      type: String,
      required: true
    }
  }
)
let libraryData = libraryUtils.getLibraryTreeByUUID(runtime.libraryTree, props.uuid)
let hoverTimer = null;
let collapseButtonHintShow = ref(false)
const iconMouseover = () => {
  hoverTimer = setTimeout(() => {
    collapseButtonHintShow.value = true;
  }, 500);
}
const iconMouseout = () => {
  clearTimeout(hoverTimer);
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
      "uuid": uuidv4(),
      "type": "songList",
      "dirName": "",
    })
  } else if (item.menuName == '新建文件夹') {
    libraryData.children.unshift({
      "uuid": uuidv4(),
      "type": "dir",
      "dirName": "",
    })
  }
}


const collapseButtonHandleClick = async () => {
  window.electron.ipcRenderer.send('collapseButtonHandleClick');
  console.log(runtime.libraryTree)
}


const dragover = (e) => {
  //todo
  e.dataTransfer.dropEffect = 'move';

}
const dragenter = (e) => {
  //todo
  e.dataTransfer.dropEffect = 'move';

}
const dragoverBlankArea = (e) => {
  //todo
  e.dataTransfer.dropEffect = 'move';

}
const dragenterBlankArea = (e) => {
  //todo
  e.dataTransfer.dropEffect = 'move';

}
const drop = (e) => {
  //todo
  console.log(runtime.dragItemData)
}
</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent">
    <div class="unselectable libraryTitle">
      <span>{{ libraryData.dirName }}</span>
      <div style="display: flex;justify-content: center;align-items: center;">
        <div class="collapseButton" @mouseover="iconMouseover()" @mouseout="iconMouseout()"
          @click="collapseButtonHandleClick()">
          <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <path d="M9 9H4v1h5V9z" />
            <path fill-rule="evenodd" clip-rule="evenodd"
              d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z" />
          </svg>
        </div>
        <transition name="fade">
          <div class="bubbleBox" v-if="collapseButtonHintShow" style="position: absolute;top: 70px;">
            折叠文件夹
          </div>
        </transition>
      </div>
    </div>
    <div class="unselectable libraryArea" v-if="libraryData.children.length" @dragover.stop.prevent="dragover"
      @dragenter.stop.prevent="dragenter" @drop.stop="drop">
      <template v-for="item of libraryData.children" :key="item.uuid">
        <libraryItem :uuid="item.uuid" />
      </template>
      <div style="flex-grow: 1;" @dragover.stop.prevent="dragoverBlankArea" @dragenter.stop.prevent="dragenterBlankArea"
        @drop.stop="dropBlankArea">
      </div>
    </div>
    <div class="unselectable" v-else
      style="height:100%;width: 100%;display: flex;justify-content: center;align-items: center;">
      <span style="font-size: 12px;color: #8c8c8c;">右键新建歌单</span>
    </div>
  </div>
  <rightClickMenu v-model="rightClickMenuShow" :menuArr="menuArr" :clickEvent="clickEvent"
    @menuButtonClick="menuButtonClick"></rightClickMenu>
</template>
<style lang="scss" scoped>
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
  height: calc(100vh - 35px);
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
  transition: opacity 0.15s
}

.fade-enter,
.fade-leave-to {
  opacity: 0
}
</style>
