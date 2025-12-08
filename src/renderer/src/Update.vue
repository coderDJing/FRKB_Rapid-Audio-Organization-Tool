<script setup lang="ts">
import chromeMiniimizeAsset from '@renderer/assets/chrome-minimize.svg?asset'
import logoAsset from '@renderer/assets/logo.png?asset'
import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import { UpdateInfo } from 'electron-updater'
import { useRuntimeStore } from '@renderer/stores/runtime'
const fillColor = ref('#9d9d9d')
const chromeMiniimize = chromeMiniimizeAsset
const logo = logoAsset

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

let newVersionInfo = ref<UpdateInfo>({
  version: '',
  files: [],
  path: '',
  sha512: '',
  releaseDate: ''
})
window.electron.ipcRenderer.once('newVersion', (event, versionInfo: UpdateInfo) => {
  newVersionInfo.value = versionInfo
  state.value = 'isNewVersion'
})

window.electron.ipcRenderer.once('isError', (event) => {
  state.value = 'isError'
})

function convertISOToCustomFormat(isoString: string) {
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

function convertBytesToUnits(bytesPerSecond: number) {
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

const runtime = useRuntimeStore()
</script>
<template>
  <div
    style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column"
    class="unselectable"
  >
    <div>
      <div class="title unselectable">{{ t('menu.checkUpdate') }}</div>
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
          <img :src="logo" style="width: 20px" :draggable="false" class="theme-icon" />
        </div>

        <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
        <div v-if="runtime.setting.platform !== 'darwin'" style="display: flex; z-index: 1">
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
      <div>{{ t('update.noUpdatesAvailable') }}</div>
      <div style="margin-top: 15px">{{ t('update.currentVersion') }} {{ latestVersion }}</div>
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
      <div>{{ t('update.updateFailed') }}</div>
      <div
        style="margin-top: 15px; max-width: 80%; word-wrap: break-word; overflow-wrap: break-word"
      >
        {{ t('update.networkIssue') }}
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
      <div>{{ t('update.newVersion') }} {{ newVersionInfo.version }}</div>
      <div style="margin-top: 15px">
        {{ t('update.releaseDate') }} {{ convertISOToCustomFormat(newVersionInfo.releaseDate) }}
      </div>
      <div style="margin-top: 20px; display: flex; justify-content: center">
        <div class="button" @click="startDownload()">{{ t('update.startUpdate') }}</div>
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
      <div class="update-progress">
        <div class="update-progress__header">
          <span>{{ t('update.downloadingUpdate') }}</span>
          <span class="update-progress__speed">{{
            convertBytesToUnits(progress.bytesPerSecond)
          }}</span>
        </div>
        <div class="update-progress__bar">
          <div class="update-progress__fill" :style="{ width: progress.percent.toFixed(2) + '%' }">
            <div class="update-progress__gloss"></div>
          </div>
          <div class="update-progress__percent">{{ progress.percent.toFixed(2) }}%</div>
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
        {{ t('update.updateDownloaded') }}
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
  background-color: var(--hover);
  font-size: 14px;

  &:hover {
    color: #ffffff;
    background-color: var(--accent);
  }
}

#app {
  color: var(--text);
  background-color: var(--bg);
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: var(--bg-elev);
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: var(--bg);
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
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
    background-color: var(--hover);
  }

  .closeIcon:hover {
    background-color: #e81123;
  }
}

.update-progress {
  width: 90%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.update-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text);
}

.update-progress__speed {
  font-size: 12px;
  color: var(--text-weak);
}

.update-progress__bar {
  position: relative;
  height: 10px;
  background: var(--bg-elev);
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid var(--border);
}

.update-progress__fill {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, #3a7afe, #4da3ff);
  background-size: 200% 100%;
  animation: updateSlideBg 2.2s linear infinite;
  transition: width 0.3s ease-in-out;
}

.update-progress__fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.12) 0 8px,
    rgba(255, 255, 255, 0.04) 8px 16px
  );
  mix-blend-mode: overlay;
  animation: updateMoveStripes 1.2s linear infinite;
}

.update-progress__gloss {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.25) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: updateShine 2.8s ease-in-out infinite;
}

.update-progress__percent {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--text);
}

@keyframes updateSlideBg {
  0% {
    background-position: 0 0;
  }

  100% {
    background-position: -200% 0;
  }
}

@keyframes updateMoveStripes {
  0% {
    background-position: 0 0;
  }

  100% {
    background-position: 100px 0;
  }
}

@keyframes updateShine {
  0% {
    transform: translateX(-100%);
  }

  50% {
    transform: translateX(0);
  }

  100% {
    transform: translateX(100%);
  }
}

.loading {
  width: 60px;
  height: 60px;
  border: 5px solid var(--text);
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
