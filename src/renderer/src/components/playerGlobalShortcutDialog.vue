<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { ref, onUnmounted, onMounted, computed } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{
  actionKey: PlayerGlobalShortcutAction
  confirmCallback: () => void
  cancelCallback: () => void
}>()

const runtime = useRuntimeStore()
if (!runtime.setting.playerGlobalShortcuts) {
  runtime.setting.playerGlobalShortcuts = {
    fastForward: 'Shift+Alt+Right',
    fastBackward: 'Shift+Alt+Left',
    nextSong: 'Shift+Alt+Down',
    previousSong: 'Shift+Alt+Up'
  }
}

const uuid = uuidV4()
const shortcutValue = ref(runtime.setting.playerGlobalShortcuts[props.actionKey])

const actionLabelMap: Record<PlayerGlobalShortcutAction, string> = {
  fastForward: t('player.fastForward'),
  fastBackward: t('player.fastBackward'),
  nextSong: t('player.next'),
  previousSong: t('player.previous')
}

const actionLabel = computed(() => actionLabelMap[props.actionKey] || '')

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const confirm = async () => {
  const current = runtime.setting.playerGlobalShortcuts?.[props.actionKey] || ''
  if (shortcutValue.value === current) {
    closeWithAnimation(() => props.confirmCallback())
    return
  }
  const result = await window.electron.ipcRenderer.invoke('playerGlobalShortcut:update', {
    action: props.actionKey,
    accelerator: shortcutValue.value
  })
  if (result?.success) {
    runtime.setting.playerGlobalShortcuts[props.actionKey] = shortcutValue.value
    closeWithAnimation(() => props.confirmCallback())
  } else {
    await confirmDialog({
      title: t('common.error'),
      innerWidth: 350,
      innerHeight: 200,
      content: [t('shortcuts.shortcutSetFailed'), t('shortcuts.tryOtherCombinations')],
      confirmShow: false
    })
  }
}

const cancel = () => {
  closeWithAnimation(() => props.cancelCallback())
}

const normalizeKey = (event: KeyboardEvent): string | null => {
  const specialMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right'
  }
  if (specialMap[event.key]) {
    return specialMap[event.key]
  }
  const upper = event.key.toUpperCase()
  if (/^[A-Z0-9]$/.test(upper)) {
    return upper
  }
  if (/^F([1-9]|1[0-2])$/.test(upper)) {
    return upper
  }
  return null
}

function handleKeyDown(event: KeyboardEvent) {
  const normalizedKey = normalizeKey(event)
  if (!normalizedKey) {
    return
  }
  event.preventDefault()
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.metaKey) {
    modifiers.push(runtime.setting.platform === 'darwin' ? 'Command' : 'Super')
  }
  modifiers.push(normalizedKey)
  shortcutValue.value = modifiers.join('+')
}

onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    void confirm()
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
      v-dialog-drag="'.dialog-title'"
      style="width: 350px; height: 200px; display: flex; flex-direction: column"
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>
          {{ t('shortcuts.playerShortcutPrompt', { action: actionLabel }) }}
        </span>
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

<style scoped lang="scss">
.shortcut-preview {
  width: 100%;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
