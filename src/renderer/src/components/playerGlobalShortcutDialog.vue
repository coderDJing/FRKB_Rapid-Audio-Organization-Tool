<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { ref, onUnmounted, onMounted, computed } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'
import {
  formatSeekPercentModifierSettingValue,
  parseSeekPercentModifierInput,
  sanitizePlayerGlobalShortcuts
} from '@shared/playerGlobalShortcuts'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = withDefaults(
  defineProps<{
    actionKey?: PlayerGlobalShortcutAction
    mode?: 'action' | 'seekPercentModifier'
    confirmCallback: () => void
    cancelCallback: () => void
  }>(),
  {
    mode: 'action'
  }
)

const runtime = useRuntimeStore()
runtime.setting.playerGlobalShortcuts = sanitizePlayerGlobalShortcuts(
  runtime.setting.playerGlobalShortcuts
)

const uuid = uuidV4()
const isModifierMode = props.mode === 'seekPercentModifier'
const shortcutValue = ref(
  isModifierMode
    ? runtime.setting.playerGlobalShortcuts.seekPercentModifier || ''
    : props.actionKey
      ? runtime.setting.playerGlobalShortcuts[props.actionKey]
      : ''
)

const actionLabelMap: Record<PlayerGlobalShortcutAction, string> = {
  togglePlayPause: t('player.playPause'),
  fastForward: t('player.fastForward'),
  fastBackward: t('player.fastBackward'),
  nextSong: t('player.next'),
  previousSong: t('player.previous')
}

const actionLabel = computed(() => (props.actionKey ? actionLabelMap[props.actionKey] || '' : ''))
const dialogTitle = computed(() =>
  isModifierMode
    ? t('shortcuts.seekPercentModifierPrompt')
    : t('shortcuts.playerShortcutPrompt', { action: actionLabel.value })
)
const previewMainText = computed(() => {
  if (!isModifierMode) return shortcutValue.value
  if (!shortcutValue.value) return t('shortcuts.globalSeekPercentShortcutOff')
  return formatSeekPercentModifierSettingValue(shortcutValue.value) || shortcutValue.value
})
const previewExampleText = computed(() => {
  if (!isModifierMode || !shortcutValue.value) return ''
  const parsed = parseSeekPercentModifierInput(shortcutValue.value)
  if (!parsed.ok || !parsed.modifier) return ''
  return t('shortcuts.seekPercentModifierPreviewExample', { modifier: parsed.modifier })
})

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const showShortcutError = async (content: string[]) => {
  await confirmDialog({
    title: t('common.error'),
    innerWidth: 350,
    innerHeight: 220,
    content,
    confirmShow: false
  })
}

const confirmActionShortcut = async () => {
  const actionKey = props.actionKey
  if (!actionKey) return
  const current = runtime.setting.playerGlobalShortcuts?.[actionKey] || ''
  if (shortcutValue.value === current) {
    closeWithAnimation(() => props.confirmCallback())
    return
  }
  const result = await window.electron.ipcRenderer.invoke('playerGlobalShortcut:update', {
    action: actionKey,
    accelerator: shortcutValue.value
  })
  if (result?.success) {
    runtime.setting.playerGlobalShortcuts[actionKey] = shortcutValue.value
    closeWithAnimation(() => props.confirmCallback())
    return
  }
  await showShortcutError([t('shortcuts.shortcutSetFailed'), t('shortcuts.tryOtherCombinations')])
}

const confirmSeekPercentModifier = async () => {
  const parsed = parseSeekPercentModifierInput(shortcutValue.value)
  if (!parsed.ok) {
    await showShortcutError([t('shortcuts.seekPercentModifierInvalid')])
    return
  }
  const current = runtime.setting.playerGlobalShortcuts.seekPercentModifier || ''
  if (parsed.modifier === current) {
    closeWithAnimation(() => props.confirmCallback())
    return
  }
  const result = await window.electron.ipcRenderer.invoke(
    'playerGlobalShortcut:updateSeekPercentModifier',
    {
      modifier: parsed.modifier
    }
  )
  if (result?.success) {
    runtime.setting.playerGlobalShortcuts.seekPercentModifier = parsed.modifier
    closeWithAnimation(() => props.confirmCallback())
    return
  }
  if (result?.reason === 'invalid') {
    await showShortcutError([t('shortcuts.seekPercentModifierInvalid')])
    return
  }
  const conflictLines = [t('shortcuts.shortcutSetFailed')]
  if (result?.accelerator) {
    conflictLines.push(
      t('shortcuts.shortcutConflictKey', { accelerator: String(result.accelerator) })
    )
  }
  conflictLines.push(t('shortcuts.tryOtherCombinations'))
  await showShortcutError(conflictLines)
}

const confirm = async () => {
  if (isModifierMode) {
    await confirmSeekPercentModifier()
    return
  }
  await confirmActionShortcut()
}

const cancel = () => {
  closeWithAnimation(() => props.cancelCallback())
}

const normalizeKey = (event: KeyboardEvent): string | null => {
  const specialMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space'
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

const collectPressedModifiers = (event: KeyboardEvent) => {
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return modifiers
}

const handleModifierKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === 'Escape') return
  event.preventDefault()
  if (event.key === 'Backspace' || event.key === 'Delete') {
    shortcutValue.value = ''
    return
  }
  const modifiers = collectPressedModifiers(event)
  if (modifiers.length === 0) return
  const raw = modifiers.join('+')
  const parsed = parseSeekPercentModifierInput(raw)
  shortcutValue.value = parsed.ok ? parsed.modifier : raw
}

function handleKeyDown(event: KeyboardEvent) {
  if (isModifierMode) {
    handleModifierKeyDown(event)
    return
  }
  const normalizedKey = normalizeKey(event)
  if (!normalizedKey) {
    return
  }
  event.preventDefault()
  const modifiers = collectPressedModifiers(event)
  if (event.metaKey) {
    modifiers.push(runtime.setting.platform === 'darwin' ? 'Command' : 'Super')
  }
  // 空格被几乎所有软件占用，全局快捷键必须带修饰键
  if (normalizedKey === 'Space' && modifiers.length === 0) {
    return
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
      :style="{
        width: isModifierMode ? '400px' : '350px',
        height: isModifierMode ? '260px' : '200px',
        display: 'flex',
        flexDirection: 'column'
      }"
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>
          {{ dialogTitle }}
        </span>
      </div>
      <div class="shortcut-preview">
        <div class="shortcut-preview-main">{{ previewMainText }}</div>
        <div v-if="previewExampleText" class="shortcut-preview-example">
          {{ previewExampleText }}
        </div>
        <div v-if="isModifierMode" class="shortcut-capture-hint">
          {{ t('shortcuts.seekPercentModifierCaptureHint') }}
        </div>
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  box-sizing: border-box;
  text-align: center;
}

.shortcut-preview-main {
  color: var(--text);
  font-size: 15px;
}

.shortcut-preview-example,
.shortcut-capture-hint {
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.5;
}
</style>
