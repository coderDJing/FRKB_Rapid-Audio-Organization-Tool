<script setup>
import chromeMiniimize from '@renderer/assets/chrome-minimize.svg'
import logo from '@renderer/assets/logo.png'
import { ref } from 'vue'
import { t } from '@renderer/utils/translate.js'
const fillColor = ref('#9d9d9d')

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('updateWindow-toggle-minimize')
}

const toggleClose = () => {
  window.electron.ipcRenderer.send('updateWindow-toggle-close')
}

let state = ref('isRequesting')

let latestVersion = ref('')
window.electron.ipcRenderer.once('isLatestVersion', (event, version) => {
  latestVersion.value = version
  state.value = 'isLatest'
})

let newVersionInfo = ref({})
window.electron.ipcRenderer.once('newVersion', (event, versionInfo) => {
  newVersionInfo.value = versionInfo
  state.value = 'isNewVersion'
})

window.electron.ipcRenderer.once('isError', (event) => {
  state.value = 'isError'
})

function convertISOToCustomFormat(isoString) {
  const date = new Date(isoString)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

const startDownload = () => {
  window.electron.ipcRenderer.send('updateWindow-startDownload')
  state.value = 'isUpdateProgress'
}
let progress = ref({
  percent: 0,
  bytesPerSecond: 0
})
window.electron.ipcRenderer.on('updateProgress', (event, progressObj) => {
  progress.value = progressObj
  state.value = 'isUpdateProgress'
})

function convertBytesToUnits(bytesPerSecond) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']
  let unitIndex = 0
  let convertedValue = bytesPerSecond

  while (convertedValue >= 1024 && unitIndex < units.length - 1) {
    convertedValue /= 1024
    unitIndex++
  }

  return `${convertedValue.toFixed(2)} ${units[unitIndex]}`
}

window.electron.ipcRenderer.on('updateDownloaded', (event) => {
  state.value = 'isUpdateDownloaded'
})
</script>
<template>
  <div
    style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column"
    class="unselectable"
  >
    <div>
      <div class="title unselectable">{{ t('检查更新') }}</div>
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
          <img :src="logo" style="width: 20px" :draggable="false" />
        </div>

        <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
        <div style="display: flex; z-index: 1">
          <div class="rightIcon" @click="toggleMinimize()">
            <img :src="chromeMiniimize" :draggable="false" />
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
    </div>
    <div
      v-if="state === 'isRequesting'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div class="loading"></div>
    </div>
    <div
      v-else-if="state === 'isLatest'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>{{ t('没有可用的更新') }}</div>
      <div style="margin-top: 15px">{{ t('当前版本') }} {{ latestVersion }}</div>
    </div>
    <div
      v-else-if="state === 'isError'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>{{ t('更新失败') }}</div>
      <div
        style="margin-top: 15px; max-width: 80%; word-wrap: break-word; overflow-wrap: break-word"
      >
        {{ t('可能由于网络连接问题，请检查您的网络连接或尝试使用代理服务器。') }}
      </div>
    </div>
    <div
      v-else-if="state === 'isNewVersion'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>{{ t('发现新版本') }} {{ newVersionInfo.version }}</div>
      <div style="margin-top: 15px">
        {{ t('发布日期') }} {{ convertISOToCustomFormat(newVersionInfo.releaseDate) }}
      </div>
      <div style="margin-top: 20px; display: flex; justify-content: center">
        <div class="button" @click="startDownload()">{{ t('开始更新') }}</div>
      </div>
    </div>
    <div
      v-else-if="state === 'isUpdateProgress'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>{{ t('正在下载更新') }} {{ convertBytesToUnits(progress.bytesPerSecond) }}</div>
      <div style="width: 90%; margin-top: 15px; border: 1px solid #ccc; position: relative">
        <div
          :style="{ width: progress.percent.toFixed(2) + '%' }"
          style="text-align: center; height: 20px; line-height: 20px; background-color: #0078d4"
        ></div>
        <div
          style="
            text-align: center;
            height: 20px;
            line-height: 20px;
            width: 100%;
            position: absolute;
            top: 0;
            left: 0;
          "
        >
          {{ progress.percent.toFixed(2) }}%
        </div>
      </div>
    </div>
    <div
      v-else-if="state === 'isUpdateDownloaded'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div style="max-width: 80%; word-wrap: break-word; overflow-wrap: break-word">
        {{ t('更新已下载，FRKB将在下次启动时自动升级') }}
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.button {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: #2d2e2e;
  font-size: 14px;

  &:hover {
    color: white;
    background-color: #0078d4;
  }
}

#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #cccccc;
  background-color: #181818;
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: #1f1f1f;
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

.loading {
  width: 60px;
  height: 60px;
  border: 5px solid #cccccc;
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>
