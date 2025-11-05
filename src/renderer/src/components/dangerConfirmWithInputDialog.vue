<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'

const uuid = uuidV4()
const emits = defineEmits(['confirm', 'cancel'])
const props = defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  placeholder: { type: String, default: 'DELETE' },
  confirmKeyword: { type: String, default: 'DELETE' },
  innerHeight: { type: Number, default: 260 },
  innerWidth: { type: Number, default: 460 }
})

const inputText = ref('')
const isValid = computed(
  () => inputText.value.trim().toLowerCase() === String(props.confirmKeyword).toLowerCase()
)

const clickConfirm = () => {
  if (!isValid.value) return
  emits('confirm', { text: inputText.value })
}
const clickCancel = () => emits('cancel')

onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    if (isValid.value) clickConfirm()
  })
  hotkeys('Esc', uuid, () => clickCancel())
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>
<template>
  <div class="dialog unselectable" style="font-size: 14px">
    <div
      class="inner"
      v-dialog-drag="'.dialog-title'"
      :style="'height:' + innerHeight + 'px;' + 'width:' + innerWidth + 'px;'"
      style="display: flex; flex-direction: column; justify-content: space-between"
    >
      <div>
        <div
          class="dialog-title"
          style="text-align: center; height: 30px; line-height: 30px; font-size: 14px"
        >
          <span style="font-weight: bold; color: #e81123">{{ props.title }}</span>
        </div>
        <div style="padding-left: 20px; padding-right: 20px">
          <div style="margin-top: 10px; text-align: left; color: #ffb900">
            <span>{{ props.description }}</span>
          </div>
          <div style="margin-top: 16px; text-align: left">
            <div style="margin-bottom: 6px">
              {{ t('common.input') }}: <b>{{ props.confirmKeyword }}</b>
            </div>
            <input
              class="dangerInput"
              v-model="inputText"
              :placeholder="props.placeholder"
              style="width: 100%"
            />
          </div>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          :class="{ disabled: !isValid }"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="clickConfirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="clickCancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dangerInput {
  height: 25px;
  line-height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  padding: 0 6px;
  border-radius: 3px;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}
.button.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
