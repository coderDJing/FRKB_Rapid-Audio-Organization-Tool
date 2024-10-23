<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidv4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
const uuid = uuidv4()
const runtime = useRuntimeStore()
const emits = defineEmits(['cancel'])

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

const folderPathVal = ref([]) //文件夹路径
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag) {
    return
  }
  clickChooseDirFlag = true
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder')
  clickChooseDirFlag = false
  if (folderPath) {
    folderPathVal.value = folderPath
  }
}

const folderPathDisplay = computed(() => {
  let newPaths = folderPathVal.value.map((path) => {
    let parts = path.split('\\')
    return parts[parts.length - 1] ? parts[parts.length - 1] : parts[parts.length - 2]
  })
  let str = []
  for (let item of newPaths) {
    str.push('"' + item + '"')
  }
  return str.join(',')
})
const confirm = () => {
  if (folderPathVal.value.length === 0) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  runtime.isProgressing = true
  window.electron.ipcRenderer.send(
    'addSongFingerprint',
    JSON.parse(JSON.stringify(folderPathVal.value))
  )
  cancel()
}
const cancel = () => {
  emits('cancel')
}
onMounted(() => {
  hotkeys('E', uuid, () => {
    confirm()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
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
          <span style="font-weight: bold">{{ t('手动添加曲目指纹') }}</span>
        </div>
        <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
          <div style="display: flex">
            <div class="formLabel">
              <span>{{ t('选择文件夹') }}：</span>
            </div>
            <div style="width: 310px">
              <div
                class="chooseDirDiv flashing-border"
                @click="clickChooseDir()"
                :title="folderPathDisplay"
                :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
              >
                {{ folderPathDisplay }}
              </div>
            </div>
          </div>
          <div style="padding-top: 40px; font-size: 12px; display: flex">
            {{
              t(
                '仅对目标文件夹及其子文件夹下的所有音频文件进行声音指纹分析，并且仅将分析结果入库，不会改动目标文件夹下的任何文件内容和结构'
              )
            }}
          </div>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirm()"
        >
          {{ t('确定') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('取消') }} (Esc)
        </div>
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
  max-width: calc(100% - 5px);
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
