<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  dialogTitle: string
  placeholder: string
  defaultValue?: string
  confirmText?: string
  confirmCallback: (value: string) => Promise<boolean>
  cancelCallback: () => void
  closeCallback: () => void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const inputValue = ref(String(props.defaultValue || ''))
const inputRef = ref<HTMLInputElement | null>(null)
const isSubmitting = ref(false)
const flashInput = ref(false)

const triggerFlash = () => {
  flashInput.value = true
  window.setTimeout(() => {
    flashInput.value = false
  }, 600)
}

const handleConfirm = async () => {
  const value = String(inputValue.value || '').trim()
  if (!value) {
    triggerFlash()
    inputRef.value?.focus()
    return
  }
  if (isSubmitting.value) return
  isSubmitting.value = true
  try {
    const ok = await props.confirmCallback(value)
    if (!ok) return
    closeWithAnimation(() => {
      props.closeCallback()
    })
  } finally {
    isSubmitting.value = false
  }
}

const handleCancel = () => {
  if (isSubmitting.value) return
  closeWithAnimation(() => {
    props.cancelCallback()
  })
}

onMounted(() => {
  inputRef.value?.focus()
  inputRef.value?.select()
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ dialogTitle }}</div>
      <div class="content">
        <input
          ref="inputRef"
          v-model="inputValue"
          class="dialog-input"
          :class="{ 'is-flashing': flashInput }"
          :placeholder="placeholder"
          :disabled="isSubmitting"
          @keydown.enter.prevent="void handleConfirm()"
          @keydown.esc.prevent="handleCancel"
        />
      </div>
      <div class="dialog-footer">
        <div
          class="button dialog-button"
          :class="{ disabled: isSubmitting }"
          @click="void handleConfirm()"
        >
          <span v-if="!isSubmitting">{{ confirmText || t('common.confirm') }}</span>
          <span v-else class="loadingWrap">
            <span class="loadingSpinner"></span>
            <span>{{ t('rekordboxDesktop.writingInProgress') }}</span>
          </span>
        </div>
        <div class="button dialog-button" :class="{ disabled: isSubmitting }" @click="handleCancel">
          {{ t('common.cancel') }}
        </div>
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

.dialog-input.is-flashing {
  border-color: var(--accent);
}

.dialog-button {
  min-width: 132px;
  text-align: center;
}

.dialog-footer {
  justify-content: center;
}

.dialog-button.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.loadingWrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.loadingSpinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: create-node-spin 0.8s linear infinite;
}

@keyframes create-node-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
