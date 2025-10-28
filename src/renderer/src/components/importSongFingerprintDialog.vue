<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
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
  const folderPath = (await window.electron.ipcRenderer.invoke('select-songFingerprintFile')) as
    | string[]
    | 'error'
    | null
  clickChooseDirFlag = false
  if (folderPath) {
    if (folderPath === 'error') {
      await confirm({
        title: t('common.error'),
        content: [t('fingerprints.notValidFile')],
        confirmShow: false
      })
    } else {
      folderPathVal.value = folderPath
    }
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
const handleConfirm = async () => {
  if (folderPathVal.value.length === 0) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  await window.electron.ipcRenderer.invoke('importSongFingerprint', folderPathVal.value[0])
  await confirm({
    title: t('common.success'),
    content: [t('import.completed')],
    confirmShow: false
  })
  cancel()
}
const cancel = () => {
  emits('cancel')
}
onMounted(() => {
  hotkeys('E', uuid, () => {
    handleConfirm()
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
          <span style="font-weight: bold">{{ t('fingerprints.importDatabase') }}</span>
        </div>
        <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
          <div style="display: flex">
            <div class="formLabel" style="white-space: nowrap">
              <span>{{ t('fingerprints.selectDatabaseFile') }}：</span>
            </div>
            <div style="flex-grow: 1; overflow: hidden">
              <div
                style="max-width: 100%; min-width: 100%"
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
            {{ t('fingerprints.importMergeHint') }}
          </div>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="handleConfirm()"
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
  width: calc(100% - 5px);
  height: 100%;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);

  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  max-width: 100%;
  font-size: 14px;
  padding-left: 5px;
  border-radius: 3px;
  box-sizing: border-box;
  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.formLabel {
  //width: 205px;
  //min-width: 205px;
  text-align: left;
  font-size: 14px;
}
</style>
