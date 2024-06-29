<script setup>
import { ref, computed, nextTick } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue';
import chevronDown from '@renderer/assets/chevron-down.svg'
import chevronRight from '@renderer/assets/chevron-right.svg'
import libraryDirItem from '@renderer/components/libraryDirItem.vue';
import librarySonglistItem from '@renderer/components/librarySonglistItem.vue'
const props = defineProps(
  {
    library: {
      type: String,
      required: true
    },
    libraryName: {
      type: String,
      required: true
    }
  }
)
let libraryData = ref({
  songListArr: []
})

window.electron.ipcRenderer.on('libraryDescriptionFilesReaded', async (event, descriptions) => {
  libraryData.value = JSON.parse(descriptions).filter((item) => item.libraryName == props.library)[0]
  libraryData.value.songListArr = []
  let songListArr = await window.electron.ipcRenderer.invoke('querySonglist', libraryData.value.path)
  libraryData.value.songListArr = songListArr
})

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
const menuArr = ref([[{ name: '新建歌单' }, { name: '新建文件夹' }]])
const contextmenuEvent = (event) => {
  clickEvent.value = event
  rightClickMenuShow.value = true
}

const menuButtonClick = async (item, e) => {
  if (item.name == '新建文件夹') {
    libraryData.value.songListArr.unshift({
      "type": "dir",
      "name": "",
      "path": "library/" + props.library
    })
  }
}

const allItemOrderUpdate = () => {
  for (let item of libraryData.value.songListArr) {
    if (item.order) {
      item.order++
    }
  }
}


</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent">
    <div class="unselectable libraryTitle">
      <span>{{ props.libraryName }}</span>
      <div style="display: flex;justify-content: center;align-items: center;">
        <div class="collapseButton" @mouseover="iconMouseover()" @mouseout="iconMouseout()">
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
    <div class="unselectable" v-if="libraryData.songListArr.length" style="height:100%;width: 100%;">
      <template v-for="(item, index) of libraryData.songListArr" :key="item.name">
        <libraryDirItem v-if="item.type == 'dir'" v-model="libraryData.songListArr[index]"
          :parentArr="libraryData.songListArr" @cancelMkDir="libraryData.songListArr.shift()"
          @allItemOrderUpdate="allItemOrderUpdate" />
        <librarySonglistItem v-if="item.type == 'songList'" />
      </template>
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
  transition: opacity 0.15s
}

.fade-enter,
.fade-leave-to {
  opacity: 0
}
</style>
