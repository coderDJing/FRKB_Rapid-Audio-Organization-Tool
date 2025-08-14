<script setup lang="ts">
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { onMounted, onUnmounted } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
const runtime = useRuntimeStore()
const uuid = uuidV4()
const toggleClose = async () => {
  runtime.setting.databaseUrl = ''
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  window.electron.ipcRenderer.send('foundOldVersionDatabaseWindow-toggle-close')
}
//确认升级
const confirmUpdate = async () => {
  window.electron.ipcRenderer.send(
    'foundOldVersionDatabaseWindow-confirmUpdate',
    runtime.setting.databaseUrl
  )
}

onMounted(() => {
  hotkeys('E', uuid, () => {
    confirmUpdate()
  })
  hotkeys('Esc', uuid, () => {
    toggleClose()
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
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
        t('database.oldVersionFound')
      }}</span>
    </div>
    <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px; height: 200px">
      <div style="padding-top: 30px; font-size: 12px; display: flex; justify-content: center">
        {{ t('database.oldVersionWarning') }}
      </div>
      <div style="padding-top: 10px; font-size: 12px; display: flex; justify-content: center">
        {{ t('database.upgradeInfo') }}
      </div>
    </div>
    <div style="display: flex; justify-content: center; padding-bottom: 10px">
      <div
        class="button"
        style="margin-right: 10px; width: 90px; text-align: center"
        @click="confirmUpdate()"
      >
        {{ t('common.confirm') }} (E)
      </div>
      <div class="button" style="width: 90px; text-align: center" @click="toggleClose()">
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

.title {
  color: #cccccc;
}

.canDrag {
  -webkit-app-region: drag;
}
</style>
