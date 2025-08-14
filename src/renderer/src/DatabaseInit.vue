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
    title: t('common.error'),
    content: [databaseUrl, t('database.cannotRead'), t('database.possibleDamage')],
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
        t('database.selectLocation')
      }}</span>
    </div>
    <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px; height: 200px">
      <div style="display: flex">
        <div class="formLabel">
          <span>{{ t('library.selectFolder') }}：</span>
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
        {{ t('database.storageHint') }}
      </div>
      <div style="padding-top: 10px; font-size: 12px; display: flex">
        {{ t('database.existingHint') }}
      </div>
    </div>
    <div style="display: flex; justify-content: center; padding-bottom: 10px">
      <div
        class="button"
        style="margin-right: 10px; width: 90px; text-align: center"
        @click="submitConfirm()"
      >
        {{ t('common.confirm') }} (E)
      </div>
      <div class="button" style="width: 90px; text-align: center" @click="cancel()">
        {{ t('menu.exit') }} (Esc)
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
