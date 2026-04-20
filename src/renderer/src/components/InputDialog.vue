<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  title: string
  value?: string
  placeholder?: string
  confirmText?: string
}>()

const emits = defineEmits<{
  (event: 'confirm', value: string): void
  (event: 'cancel'): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const inputValue = ref(props.value || '')
const inputRef = ref<HTMLInputElement | null>(null)

const handleConfirm = () => {
  closeWithAnimation(() => emits('confirm', inputValue.value))
}

const handleCancel = () => {
  closeWithAnimation(() => emits('cancel'))
}

onMounted(() => {
  inputRef.value?.focus()
  inputRef.value?.select()
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ title }}</div>
      <div class="content">
        <input
          ref="inputRef"
          v-model="inputValue"
          class="dialog-input"
          :placeholder="placeholder || ''"
          @keydown.enter.prevent="handleConfirm"
          @keydown.esc.prevent="handleCancel"
        />
      </div>
      <div class="dialog-footer">
        <div class="button" @click="handleConfirm">{{ confirmText || t('common.confirm') }}</div>
        <div class="button" @click="handleCancel">{{ t('common.cancel') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 420px;
  max-width: calc(100vw - 20px);
  padding: 0;
  display: flex;
  flex-direction: column;
}

.content {
  padding: 18px;
}

.dialog-input {
  width: 100%;
  height: 32px;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 0 10px;
  outline: none;
}

.dialog-input:focus {
  border-color: var(--accent);
}
</style>
