<script setup lang="ts">
import { defineProps, defineEmits, computed, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{
  visible: boolean
  context: string
  done: number
  running: number
  pending: number
  successSoFar?: number
  failedSoFar?: number
}>()
const emit = defineEmits<{
  (e: 'resume'): void
  (e: 'cancel'): void
}>()

// 将“进行中”合并进待处理，避免歧义
const pendingAll = computed(() => props.pending + props.running)
const totalDone = computed(() => props.done)
const shouldRender = ref(false)
const { dialogVisible, closeWithAnimation, show } = useDialogTransition()

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      shouldRender.value = true
      show()
    } else if (shouldRender.value) {
      closeWithAnimation(() => {
        shouldRender.value = false
      })
    }
  },
  { immediate: true }
)

const handleResume = () => {
  closeWithAnimation(() => {
    shouldRender.value = false
    emit('resume')
  })
}

const handleCancel = () => {
  closeWithAnimation(() => {
    shouldRender.value = false
    emit('cancel')
  })
}
</script>

<template>
  <div v-if="shouldRender" class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="title dialog-title">{{ t('errors.diskFullTitle') }}</div>
      <div class="content">
        <div style="margin-top: 6px">
          {{ t('errors.diskFullInterruptedHint', { done: totalDone, pending: pendingAll }) }}
        </div>
      </div>
      <div class="actions">
        <div class="button" style="width: 90px; text-align: center" @click="handleCancel">
          {{ t('common.skip') }}
        </div>
        <div
          class="button"
          style="width: 90px; text-align: center; margin-left: 10px"
          @click="handleResume"
        >
          {{ t('common.retry') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.title {
  text-align: center;
  font-weight: bold;
  color: #e5e5e5;
}
.content {
  font-size: 13px;
  color: #d0d0d0;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 0;
  padding-top: 6px;
}
</style>
