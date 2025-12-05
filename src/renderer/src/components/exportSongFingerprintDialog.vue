<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, useTemplateRef } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const uuid = uuidV4()
const emits = defineEmits(['cancel'])

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

const folderPathVal = ref<string[]>([]) //文件夹路径
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag) {
    return
  }
  clickChooseDirFlag = true
  const folderPath = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    | string[]
    | null
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
const folderPathDisplayWithPlaceholder = computed(() => {
  return folderPathDisplay.value || t('library.clickToSelect')
})
const folderPathTooltip = computed(() => {
  return folderPathDisplay.value || t('library.clickToSelect')
})
const chooseDirRef = useTemplateRef<HTMLDivElement>('chooseDirRef')
const confirm = async () => {
  if (folderPathVal.value.length === 0) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  await window.electron.ipcRenderer.invoke('exportSongFingerprint', folderPathVal.value[0])
  cancel()
}
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const cancel = () => {
  closeWithAnimation(() => emits('cancel'))
}
onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
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
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      style="
        width: 500px;
        height: 320px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
      v-dialog-drag="'.dialog-title'"
    >
      <div>
        <div
          class="dialog-title"
          style="text-align: center; height: 30px; line-height: 30px; font-size: 14px"
        >
          <span style="font-weight: bold">{{ t('fingerprints.exportDatabase') }}</span>
        </div>
        <div style="padding: 20px; font-size: 14px">
          <div>{{ t('export.exportTo') }}：</div>
          <div style="margin-top: 10px">
            <div
              ref="chooseDirRef"
              class="chooseDirDiv flashing-border"
              @click="clickChooseDir()"
              :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
            >
              {{ folderPathDisplayWithPlaceholder }}
            </div>
            <bubbleBox
              :dom="chooseDirRef || undefined"
              :title="folderPathTooltip"
              :maxWidth="320"
            />
          </div>
          <div style="margin-top: 20px; font-size: 12px; color: #999">
            {{ t('fingerprints.exportHint') }}
          </div>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.chooseDirDiv {
  width: 100%;
  height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 3px;
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  max-width: 100%;
  font-size: 14px;
  padding-left: 5px;
  box-sizing: border-box;
  line-height: 25px;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}
</style>
