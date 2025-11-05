<script setup lang="ts">
import { defineProps, defineEmits, computed } from 'vue'
import { t } from '@renderer/utils/translate'

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
</script>

<template>
  <div v-if="props.visible" class="dialog unselectable">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="title dialog-title">{{ t('errors.diskFullTitle') }}</div>
      <div class="content">
        <div style="margin-top: 6px">
          {{ t('errors.diskFullInterruptedHint', { done: totalDone, pending: pendingAll }) }}
        </div>
      </div>
      <div class="actions">
        <div class="button" style="width: 90px; text-align: center" @click="emit('cancel')">
          {{ t('common.skip') }}
        </div>
        <div
          class="button"
          style="width: 90px; text-align: center; margin-left: 10px"
          @click="emit('resume')"
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
