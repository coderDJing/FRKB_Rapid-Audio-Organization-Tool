<script setup>
import singleCheckbox from './singleCheckbox.vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidv4 } from 'uuid'
import utils from '../utils/utils'
import { ref, onUnmounted, onMounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
const uuid = uuidv4()
const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  }
})
const runtime = useRuntimeStore()
const flashArea = ref('') // 控制动画是否正在播放

// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName) => {
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
const deleteSongsAfterExport = ref(false)
let localStorageData = localStorage.getItem('exportDialog')
if (localStorageData === null) {
  localStorage.setItem(
    'exportDialog',
    JSON.stringify({
      deleteSongsAfterExport: true
    })
  )
  deleteSongsAfterExport.value = true
} else {
  localStorageData = JSON.parse(localStorageData)
  deleteSongsAfterExport.value = localStorageData.deleteSongsAfterExport
}

const confirm = () => {
  if (folderPathVal.value === '') {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  props.confirmCallback({
    folderPathVal: folderPathVal.value,
    deleteSongsAfterExport: deleteSongsAfterExport.value
  })
}

const cancel = () => {
  props.cancel()
}

onMounted(() => {
  hotkeys('e,enter', uuid, () => {
    confirm()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(runtime.hotkeysScopesHeap, uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(runtime.hotkeysScopesHeap, uuid)
})
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 450px;
        height: 300px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ props.title }}导出</span>
        </div>
        <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
          <div style="display: flex">
            <div class="formLabel"><span>导出到文件夹：</span></div>
            <div style="flex-grow: 1">
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
          <div style="margin-top: 30px; display: flex">
            <div class="formLabel" style="width: 112px; text-align: right">
              <span>导出后删除曲目：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox v-model="deleteSongsAfterExport" />
            </div>
          </div>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" style="margin-right: 10px" @click="confirm()">确定 ↵</div>
        <div class="button" @click="cancel()">取消 Esc</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.chooseDirDiv {
  width: calc(100% - 5px);
  height: 100%;
  background-color: #313131;
  cursor: pointer;
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  max-width: 100%;
  font-size: 14px;
  padding-left: 5px;
}

.formLabel {
  width: 100px;
  min-width: 100px;
  text-align: left;
  font-size: 14px;
}
</style>
