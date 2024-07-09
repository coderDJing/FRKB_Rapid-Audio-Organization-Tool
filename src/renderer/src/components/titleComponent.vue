<script setup>
import chromeMaximize from '@renderer/assets/chrome-maximize.svg'
import chromeRestore from '@renderer/assets/chrome-restore.svg'
import chromeMiniimize from '@renderer/assets/chrome-minimize.svg'
import logo from '@renderer/assets/logo.png'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ref } from 'vue'
import menuComponent from './menu.vue'

const emit = defineEmits(['openDialog'])
const toggleMaximize = () => {
  window.electron.ipcRenderer.send('toggle-maximize')
}

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('toggle-minimize')
}

const toggleClose = () => {
  window.electron.ipcRenderer.send('toggle-close')
}
const runtime = useRuntimeStore()

window.electron.ipcRenderer.on('mainWin-max', (event, bool) => {
  runtime.isWindowMaximized = bool
})

const fillColor = ref('#9d9d9d')

const menuArr = ref([
  {
    name: '文件(F)',
    show: false,
    subMenu: [
      [{ name: '导入新歌曲', shortcutKey: 'Ctrl+R' }, { name: '手动添加歌曲指纹' }],
      [{ name: '退出' }]
    ]
  },
  {
    name: '帮助(H)',
    show: false,
    subMenu: [[{ name: '使用说明' }, { name: '关于' }]]
  }
])
const menuClick = (item) => {
  item.show = true
}
const menuButtonClick = (item) => {
  emit('openDialog', item.name)
}
</script>
<template>
  <div class="title unselectable">Better Music Library</div>
  <div class="titleComponent unselectable">
    <div
      style="
        z-index: 1;
        padding-left: 10px;
        display: flex;
        justify-content: center;
        align-items: center;
      "
    >
      <img :src="logo" style="width: 22px" />
    </div>
    <div style="z-index: 1; padding-left: 5px" v-for="item in menuArr" :key="item.name">
      <div class="functionButton" @click.stop="menuClick(item)">{{ item.name }}</div>
      <menuComponent
        :menuArr="item.subMenu"
        v-model="item.show"
        @menuButtonClick="menuButtonClick"
      ></menuComponent>
    </div>
    <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
    <div style="display: flex; z-index: 1">
      <div class="rightIcon" @click="toggleMinimize()">
        <img :src="chromeMiniimize" />
      </div>
      <div class="rightIcon" @click="toggleMaximize()">
        <img :src="runtime.isWindowMaximized ? chromeRestore : chromeMaximize" />
      </div>
      <div
        class="rightIcon closeIcon"
        @mouseover="fillColor = '#ffffff'"
        @mouseout="fillColor = '#9d9d9d'"
        @click="toggleClose()"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 15 15"
          xmlns="http://www.w3.org/2000/svg"
          :fill="fillColor"
        >
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
          />
        </svg>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.functionButton {
  height: 22px;
  line-height: 22px;
  padding: 0 5px;
  cursor: pointer;
  font-size: 12px;
  border-radius: 5px;
}

.functionButton:hover {
  background-color: #2d2e2e;
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #181818;
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid #424242;
}

.titleComponent {
  width: 100vw;
  height: 35px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  box-sizing: border-box;

  .rightIcon {
    width: 47px;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 35px;
    transition: background-color 0.15s ease;
  }

  .rightIcon:hover {
    background-color: #373737;
  }

  .closeIcon:hover {
    background-color: #e81123;
  }
}
</style>
