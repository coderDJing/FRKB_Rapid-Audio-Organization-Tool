<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { ref, onUnmounted, onMounted } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const uuid = uuidV4()
const props = defineProps({
  confirmCallback: {
    type: Function,
    required: true
  },
  cancelCallback: {
    type: Function,
    required: true
  }
})
const runtime = useRuntimeStore()
const shortcutValue = ref(runtime.setting.globalCallShortcut)

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const confirm = async () => {
  if (shortcutValue.value !== runtime.setting.globalCallShortcut) {
    const result = await window.electron.ipcRenderer.invoke(
      'changeGlobalShortcut',
      shortcutValue.value
    )
    if (result) {
      runtime.setting.globalCallShortcut = shortcutValue.value
    } else {
      await confirmDialog({
        title: t('common.error'),
        innerWidth: 350,
        innerHeight: 200,
        content: [t('shortcuts.shortcutSetFailed'), t('shortcuts.tryOtherCombinations')],
        confirmShow: false
      })
      return
    }
  }
  closeWithAnimation(() => props.confirmCallback())
}

const cancel = () => {
  closeWithAnimation(() => props.cancelCallback())
}
function isLetterOrDigitOrF1ToF12(event: KeyboardEvent) {
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
function handleKeyDown(event: KeyboardEvent) {
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
  hotkeys('E,Enter', uuid, () => {
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
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      style="width: 350px; height: 200px; display: flex; flex-direction: column"
      class="inner"
      v-dialog-drag="'.dialog-title'"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('shortcuts.enterNewShortcut') }}</span>
      </div>
      <div class="shortcut-preview">
        {{ shortcutValue }}
      </div>
      <div class="dialog-footer">
        <div class="button" @click="confirm()">{{ t('common.confirm') }} (E)</div>
        <div class="button" @click="cancel()">{{ t('common.cancel') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.shortcut-preview {
  width: 100%;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
