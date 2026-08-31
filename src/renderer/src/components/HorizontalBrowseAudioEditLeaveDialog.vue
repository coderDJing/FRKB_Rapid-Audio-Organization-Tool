<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'

const emit = defineEmits<{
  (event: 'save'): void
  (event: 'discard'): void
  (event: 'cancel'): void
}>()

const uuid = uuidV4()
const runtime = useRuntimeStore()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const saveButtonRef = ref<HTMLButtonElement | null>(null)

watch(dialogVisible, (visible) => {
  if (visible) void nextTick(() => saveButtonRef.value?.focus())
})

const finish = (event: 'save' | 'discard' | 'cancel') => {
  closeWithAnimation(() => {
    if (event === 'save') emit('save')
    else if (event === 'discard') emit('discard')
    else emit('cancel')
  })
}

onMounted(() => {
  hotkeys('E,Enter', uuid, () => finish('save'))
  hotkeys('Esc', uuid, () => finish('cancel'))
  utils.setHotkeysScpoe(uuid)
  runtime.confirmShow = true
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.confirmShow = false
})
</script>

<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="`${uuid}-title`"
  >
    <div v-dialog-drag="'.dialog-title'" class="inner" style="width: 420px; height: auto">
      <div class="dialog-title dialog-header">
        <span :id="`${uuid}-title`">{{ t('audioEdit.unsavedTitle') }}</span>
      </div>
      <div class="audio-edit-leave">{{ t('audioEdit.unsavedContent') }}</div>
      <div class="dialog-footer">
        <button ref="saveButtonRef" type="button" class="button" @click="finish('save')">
          {{ t('audioEdit.saveAction') }} (E)
        </button>
        <button type="button" class="button audio-edit-leave__discard" @click="finish('discard')">
          {{ t('audioEdit.discardAction') }}
        </button>
        <button type="button" class="button" @click="finish('cancel')">
          {{ t('audioEdit.cancelAction') }} (Esc)
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.audio-edit-leave {
  padding: 18px 20px;
  text-align: center;
  color: var(--text);
}

.audio-edit-leave__discard {
  color: var(--danger, #d84a4a) !important;
}

.dialog-footer {
  justify-content: center;
  flex-wrap: wrap;
}

.dialog-footer .button {
  border: 0;
  color: var(--text);
  cursor: pointer;
}
</style>
