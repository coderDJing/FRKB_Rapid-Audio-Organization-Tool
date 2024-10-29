<script setup>
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { ref, onUnmounted, onMounted } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog'
const uuid = uuidV4()
const props = defineProps({
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  }
})
const runtime = useRuntimeStore()
const shortcutValue = ref(runtime.setting.globalCallShortcut)

const confirm = async () => {
  if (shortcutValue.value !== runtime.setting.globalCallShortcut) {
    let result = await window.electron.ipcRenderer.invoke(
      'changeGlobalShortcut',
      shortcutValue.value
    )
    if (result) {
      runtime.setting.globalCallShortcut = shortcutValue.value
      props.confirmCallback()
    } else {
      await confirmDialog({
        title: '错误',
        innerWidth: 350,
        innerHeight: 200,
        content: [t('快捷键设置失败，可能是由于冲突或错误'), t('请尝试其他组合')],
        confirmShow: false
      })
    }
  } else {
    props.confirmCallback()
  }
}

const cancel = () => {
  props.cancelCallback()
}
function isLetterOrDigitOrF1ToF12(event) {
  const keyCode = event.keyCode

  // 判断是否为字母
  if ((keyCode >= 65 && keyCode <= 90) || (keyCode >= 97 && keyCode <= 122)) {
    return true
  }

  // 判断是否为数字
  if (keyCode >= 48 && keyCode <= 57) {
    return true
  }

  // 判断是否为 F1 到 F12
  if (keyCode >= 112 && keyCode <= 123) {
    return true
  }

  // 其他情况返回 false
  return false
}
function handleKeyDown(event) {
  const key = event.key
  if (!isLetterOrDigitOrF1ToF12(event)) {
    return
  }
  const modifiers = []
  if (runtime.platform === 'Windows') {
    if (event.ctrlKey) modifiers.push('Ctrl')
    if (event.altKey) modifiers.push('Alt')
    if (event.shiftKey) modifiers.push('Shift')
  } else if (runtime.platform === 'Mac') {
    //todo
  }
  shortcutValue.value = modifiers.join('+') + (modifiers.length ? '+' : '') + key.toUpperCase()
}
onMounted(() => {
  hotkeys('E', uuid, () => {
    confirm()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
  window.addEventListener('keydown', handleKeyDown)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  window.removeEventListener('keydown', handleKeyDown)
})
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 350px;
        height: 200px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ t('请直接在键盘上输入新的快捷键') }}</span>
        </div>
        <div style="width: 100%; height: 100px; line-height: 100px; text-align: center">
          {{ shortcutValue }}
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" style="margin-right: 10px" @click="confirm()">{{ t('确定') }} (E)</div>
        <div class="button" @click="cancel()">{{ t('取消') }} (Esc)</div>
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
  width: calc(100% - 5px);
  font-size: 14px;
  padding-left: 5px;
}

.formLabel {
  text-align: left;
  font-size: 14px;
}
</style>
