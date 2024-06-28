<script setup>
import { ref, computed, nextTick } from 'vue'
import rightClickMenu from '../../components/rightClickMenu.vue';
import chevronDown from '@renderer/assets/chevron-down.svg'
import chevronRight from '@renderer/assets/chevron-right.svg'
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
const menuArr = ref([])
const contextmenuEvent = (event) => {
  if (event.target.className.split(' ').indexOf('blankArea') != -1) {
    menuArr.value = [[{ name: '新建歌单' }, { name: '新建文件夹' }]]
  }
  clickEvent.value = event
  rightClickMenuShow.value = true
}

let operationInputTargetArr = []
let operationInputValue = ref('')
const inputBlurHandle = () => {
  inputHintShow.value = false
  if (operationInputValue.value) {
    //todo(查重当前路径有没有重名)
    debugger
    return
    await window.electron.ipcRenderer.invoke('mkDir', {
      "type": "dir",
      "name": operationInputValue.value,
      "path": operationInputTargetArr[0].path + operationInputValue.value,
      "order": 1
    }, operationInputTargetArr[0].path)
    operationInputTargetArr[0].name = operationInputValue.value
    operationInputValue.value = ''
    //todo

  } else {
    if (operationInputTargetArr[0].name === '') {
      operationInputTargetArr.shift()
    }
  }
}
const myInputHandleInput = (e) => {
  if (operationInputValue.value == '') {
    inputHintShow.value = true
  } else {
    inputHintShow.value = false
  }
}
const inputHintShow = ref(false)
const inputKeyDownEnter = () => {
  if (!operationInputValue.value) {
    inputHintShow.value = true
  } else {
    myInput.value[0].blur();
  }
}
const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputBlurHandle()
}

const myInput = ref(null)
const menuButtonClick = async (item, e) => {
  if (item.name == '新建文件夹') {
    if (e.target.className.split(' ').indexOf('blankArea') != -1) {
      libraryData.value.songListArr.unshift({
        "type": "dir",
        "name": "",
        "path": "library/" + props.libraryName
      })
      operationInputTargetArr = libraryData.value.songListArr
      await nextTick()
      myInput.value[0].focus();
    }
  }
}




</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent">
    <div class="unselectable blankArea libraryTitle">
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
    <div class="unselectable blankArea" v-if="libraryData.songListArr.length" style="height:100%;width: 100%;">
      <div v-for="item of libraryData.songListArr" style="display: flex;cursor: pointer;">
        <div class="prefixIcon">
          <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd"
              d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" />
          </svg>
          <!-- <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd"
              d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
          </svg> -->
        </div>
        <div style="height:23px;flex-grow: 1;">
          <div v-if="item.name" style="line-height: 23px;font-size: 13px;">{{ item.name }}</div>
          <div v-else>
            <input ref="myInput" v-model="operationInputValue" class="myInput"
              :class="{ 'myInputRedBorder': inputHintShow }" @blur="inputBlurHandle" @keydown.enter="inputKeyDownEnter"
              @keydown.esc="inputKeyDownEsc" @click.stop="() => { }" @contextmenu.stop="() => { }"
              @input="myInputHandleInput" />
            <div v-show="inputHintShow" class="myInputHint">
              <div>必须提供歌单或文件夹名。</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="unselectable blankArea" v-else
      style="height:100%;width: 100%;display: flex;justify-content: center;align-items: center;">
      <span class="blankArea" style="font-size: 12px;color: #8c8c8c;">右键新建歌单</span>
    </div>
  </div>
  <rightClickMenu v-model="rightClickMenuShow" :menuArr="menuArr" :clickEvent="clickEvent"
    @menuButtonClick="menuButtonClick"></rightClickMenu>
</template>
<style lang="scss" scoped>
.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: #313131;
  border: 1px solid #086bb7;
  outline: none;
  color: #cccccc
}

.myInputRedBorder {
  border: 1px solid #be1100;
}

.myInputHint {
  div {
    width: calc(100% - 7px);
    height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border-right: 1px solid #be1100;
    border-left: 1px solid #be1100;
    border-bottom: 1px solid #be1100;
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 100;
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

  .prefixIcon {
    color: #cccccc;
    width: 20px;
    min-width: 20px;
    height: 23px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

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
