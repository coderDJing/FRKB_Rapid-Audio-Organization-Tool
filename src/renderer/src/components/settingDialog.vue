<script setup>
import { onUnmounted, onMounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidv4 } from 'uuid'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate.js'
const runtime = useRuntimeStore()
const uuid = uuidv4()
const emits = defineEmits(['cancel'])
const cancel = () => {
  emits('cancel')
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

const languageChanged = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

//todo
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 60vw;
        height: 70vh;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
    >
      <div style="height: 100%; display: flex; flex-direction: column">
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">设置</span>
        </div>
        <div style="padding: 20px; font-size: 14px; flex-grow: 1; overflow-y: scroll">
          <div>{{ t('语言') }}：</div>
          <div style="margin-top: 10px">
            <select v-model="runtime.setting.language" @change="languageChanged">
              <option value="zhCN">简体中文</option>
              <option value="enUS">English</option>
            </select>
          </div>
          <!-- todo -->
        </div>
        <div style="display: flex; justify-content: center; padding-bottom: 10px; height: 30px">
          <div class="button" @click="cancel()">{{ t('关闭') }} (Esc)</div>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss">
select {
  border: 0px solid #313131;
  background-color: #313131;
  color: #cccccc;
  font-size: 14px;
  width: 200px;
  height: 25px;
  padding-left: 5px;
  outline: none;
}

/* 美化选项内容 */
option {
  padding: 5px;
  background-color: #1f1f1f;
  color: #cccccc;
}
</style>
