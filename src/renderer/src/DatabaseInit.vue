<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { t } from '@renderer/utils/translate'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
const runtime = useRuntimeStore()
const uuid = uuidV4()
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
const folderPathVal = ref('') //文件夹路径
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag) {
    return
  }
  clickChooseDirFlag = true
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder', false)
  clickChooseDirFlag = false
  if (folderPath) {
    folderPathVal.value = folderPath[0]
  }
}
const submitConfirm = async () => {
  if (folderPathVal.value.length === 0) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }

  // 检查选择的路径是否已经以 FRKB_database 结尾
  const separator = runtime.setting.platform === 'win32' ? '\\' : '/'
  const folderName = folderPathVal.value.split(separator).pop()

  runtime.setting.databaseUrl =
    folderName === 'FRKB_database'
      ? folderPathVal.value
      : folderPathVal.value + separator + 'FRKB_database'

  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  await window.electron.ipcRenderer.invoke(
    'databaseInitWindow-InitDataBase',
    runtime.setting.databaseUrl
  )
}
const cancel = () => {
  window.electron.ipcRenderer.send('databaseInitWindow-toggle-close')
}
onMounted(() => {
  hotkeys('E', uuid, () => {
    submitConfirm()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

window.electron.ipcRenderer.on('databaseInitWindow-showErrorHint', async (event, databaseUrl) => {
  await confirm({
    title: '错误',
    content: [
      databaseUrl,
      t('位于此位置的数据库已无法读取'),
      t(
        '数据库可能已被移动或其必要文件结构已损坏。如果确认数据库未被移动，重新选择此位置将尝试修复数据库。'
      )
    ],
    confirmShow: false
  })
})
</script>

<template>
  <div
    style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column"
    class="unselectable"
  >
    <div
      style="text-align: center; height: 30px; line-height: 30px; font-size: 14px"
      class="canDrag"
    >
      <span style="font-weight: bold" class="title unselectable">{{
        t('请选择数据存储位置')
      }}</span>
    </div>
    <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px; height: 200px">
      <div style="display: flex">
        <div class="formLabel">
          <span>{{ t('选择文件夹') }}：</span>
        </div>
        <div style="flex-grow: 1; overflow: hidden">
          <div
            class="chooseDirDiv flashing-border"
            @click="clickChooseDir()"
            :title="folderPathVal"
            :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
          >
            {{ folderPathVal }}
          </div>
        </div>
      </div>
      <div style="padding-top: 30px; font-size: 12px; display: flex">
        {{ t('用户的曲目及曲目指纹信息将储存在此处，请确保此文件夹有足够空间') }}
      </div>
      <div style="padding-top: 10px; font-size: 12px; display: flex">
        {{ t('如果目标文件夹下已经存在FRKB数据库文件夹，‌那么将会直接使用已有的数据库内容') }}
      </div>
    </div>
    <div style="display: flex; justify-content: center; padding-bottom: 10px">
      <div
        class="button"
        style="margin-right: 10px; width: 90px; text-align: center"
        @click="submitConfirm()"
      >
        {{ t('确定') }} (E)
      </div>
      <div class="button" style="width: 90px; text-align: center" @click="cancel()">
        {{ t('退出') }} (Esc)
      </div>
    </div>
  </div>
</template>
<style lang="scss">
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

.chooseDirDiv {
  height: 100%;
  background-color: #313131;
  cursor: pointer;
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  font-size: 14px;
  padding-left: 5px;
}

.formLabel {
  width: 110px;
  min-width: 110px;
  text-align: left;
  font-size: 14px;
}
</style>
