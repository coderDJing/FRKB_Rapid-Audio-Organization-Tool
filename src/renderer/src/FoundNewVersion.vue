<script setup lang="ts">
import chromeMiniimize from '@renderer/assets/chrome-minimize.svg?asset'
import logo from '@renderer/assets/logo.png?asset'
import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import singleCheckbox from './components/singleCheckbox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
const fillColor = ref('#9d9d9d')

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('foundNewVersionWindow-toggle-minimize')
}
function getSevenDaysLater() {
  const currentDate = new Date()
  const sevenDaysLater = new Date(currentDate.getTime() + 7 * 24 * 60 * 60 * 1000)
  return sevenDaysLater.toLocaleDateString()
}
const notCheckIn7Days = ref(false)
const runtime = useRuntimeStore()
const toggleClose = async () => {
  if (notCheckIn7Days.value) {
    runtime.setting.nextCheckUpdateTime = getSevenDaysLater()
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }
  window.electron.ipcRenderer.send('foundNewVersionWindow-toggle-close')
}
const checkNow = async () => {
  await window.electron.ipcRenderer.invoke('foundNewVersionWindow-checkForUpdates')
  window.electron.ipcRenderer.send('foundNewVersionWindow-toggle-close')
}
</script>
<template>
  <div
    style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column"
    class="unselectable"
  >
    <div>
      <div class="title unselectable">{{ t('update.newVersionFound') }}</div>
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
        <div v-if="navigator.userAgent.includes('Mac') === false" style="display: flex; z-index: 1">
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
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div style="display: flex; justify-content: center">
        <div class="button" style="width: 110px; text-align: center" @click="checkNow()">
          {{ t('menu.checkUpdate') }}
        </div>
        <div
          class="button"
          style="width: 110px; text-align: center; margin-left: 15px"
          @click="toggleClose()"
        >
          {{ t('update.notNow') }}
        </div>
      </div>
      <div>
        <div style="margin-top: 30px; display: flex">
          <div class="formLabel" style="text-align: right">
            <span>{{ t('update.doNotCheckFor7Days') }}：</span>
          </div>
          <div style="flex: 1; width: 21px; height: 21px; display: flex; align-items: center">
            <singleCheckbox v-model="notCheckIn7Days" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss">
.formLabel {
  text-align: left;
  font-size: 12px;
}

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
</style>
