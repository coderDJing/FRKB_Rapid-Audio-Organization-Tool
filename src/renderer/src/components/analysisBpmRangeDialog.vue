<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { buildAnalysisBpmRangeOptions } from '@renderer/utils/analysisBpmRangeUi'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import {
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'

const props = defineProps<{
  count: number
  initialRangeId: AnalysisBpmRangePresetId
  confirmCallback?: (value: AnalysisBpmRangePresetId) => void
  cancelCallback?: () => void
}>()

const runtime = useRuntimeStore()
const uuid = uuidV4()
const selectedRangeId = ref<AnalysisBpmRangePresetId>(
  normalizeAnalysisBpmRangeId(props.initialRangeId)
)
const options = computed(() => buildAnalysisBpmRangeOptions(selectedRangeId.value))
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const confirm = () => {
  closeWithAnimation(() => props.confirmCallback?.(selectedRangeId.value))
}

const cancel = () => {
  closeWithAnimation(() => props.cancelCallback?.())
}

onMounted(() => {
  runtime.confirmShow = true
  hotkeys('E,Enter', uuid, confirm)
  hotkeys('Esc', uuid, cancel)
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  runtime.confirmShow = false
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner analysis-bpm-range-dialog">
      <div class="dialog-title dialog-header">
        <span>{{ t('settings.analysisBpmRange.dialogTitle') }}</span>
      </div>

      <div class="analysis-bpm-range-dialog__content">
        <div class="analysis-bpm-range-dialog__summary">
          {{ t('settings.analysisBpmRange.dialogSummary', { count: props.count }) }}
        </div>
        <div class="analysis-bpm-range-dialog__field">
          <span>{{ t('settings.analysisBpmRange.label') }}</span>
          <BaseSelect v-model="selectedRangeId" :options="options" :width="180" :max-height="280" />
        </div>
        <div class="analysis-bpm-range-dialog__hint">
          {{ t('settings.analysisBpmRange.dialogHint') }}
        </div>
      </div>

      <div class="dialog-footer">
        <div class="button analysis-bpm-range-dialog__button" @click="confirm">
          {{ t('settings.analysisBpmRange.start') }} (E)
        </div>
        <div class="button analysis-bpm-range-dialog__button" @click="cancel">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.analysis-bpm-range-dialog {
  width: 430px;
  height: auto;
  min-height: 260px;
  display: flex;
  flex-direction: column;
}

.analysis-bpm-range-dialog__content {
  flex: 1;
  padding: 24px 28px 18px;
  color: var(--text);
}

.analysis-bpm-range-dialog__summary {
  margin-bottom: 22px;
  text-align: center;
  line-height: 1.6;
}

.analysis-bpm-range-dialog__field {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
}

.analysis-bpm-range-dialog__hint {
  margin-top: 20px;
  color: var(--text-secondary, #8c8c8c);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.analysis-bpm-range-dialog__button {
  min-width: 132px;
  padding: 0 14px;
  box-sizing: border-box;
  text-align: center;
  white-space: nowrap;
}
</style>
