<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const uuid = uuidV4()
const emits = defineEmits(['select'])
const props = defineProps<{
  title?: string
  content?: string[]
  options: { key: string; label: string }[]
  innerHeight?: number
  innerWidth?: number
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const clickOption = (key: string) => {
  closeWithAnimation(() => emits('select', key))
}

// 为常见三选项设置快捷键：enter=Q, reset=E, cancel=Esc
const keyHint = (key: string, index: number) => {
  if (key === 'enter') return 'Q'
  if (key === 'reset') return 'E'
  if (key === 'cancel') return 'Esc'
  // 其它情况不显示默认数字，保持简洁
  return ''
}

onMounted(() => {
  hotkeys('q,Q', uuid, () => clickOption('enter'))
  hotkeys('e,E', uuid, () => clickOption('reset'))
  hotkeys('Esc', uuid, () => clickOption('cancel'))
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>
<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px"
  >
    <div
      class="inner"
      v-dialog-drag="'.dialog-title'"
      :style="'height:' + (innerHeight || 220) + 'px;' + 'width:' + (innerWidth || 460) + 'px;'"
      style="display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ props.title }}</span>
      </div>
      <div style="padding: 0 20px; flex: 1; overflow-y: auto">
        <div v-for="line in props.content || []" style="margin-top: 10px; text-align: left">
          <span>{{ line }}</span>
        </div>
      </div>
      <div class="dialog-footer">
        <div
          v-for="(opt, i) in props.options"
          :key="opt.key"
          class="button"
          style="min-width: 120px; text-align: center"
          @click="clickOption(opt.key)"
        >
          {{ opt.label }}<span v-if="keyHint(opt.key, i)"> ({{ keyHint(opt.key, i) }})</span>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped></style>
