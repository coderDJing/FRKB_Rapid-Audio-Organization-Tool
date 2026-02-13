<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import BaseSelect from '@renderer/components/BaseSelect.vue'

const props = defineProps({
  outputPath: {
    type: String,
    default: ''
  },
  outputFormat: {
    type: String as () => 'wav' | 'mp3',
    default: 'wav'
  },
  outputFilename: {
    type: String,
    default: ''
  }
})

const emit = defineEmits<{
  (
    event: 'confirm',
    payload: { outputPath: string; outputFormat: 'wav' | 'mp3'; outputFilename: string }
  ): void
  (event: 'cancel'): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const draftPath = ref(props.outputPath)
const draftFormat = ref<'wav' | 'mp3'>(props.outputFormat)
const draftFilename = ref(props.outputFilename)

const outputPathDisplay = computed(() => {
  return draftPath.value || t('mixtape.outputPathPlaceholder')
})

const formatOptions = computed(() => [
  { label: 'WAV', value: 'wav' },
  { label: 'MP3', value: 'mp3' }
])

const handlePickOutputPath = async () => {
  const result = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    | string[]
    | null
  const nextPath = Array.isArray(result) ? result[0] : ''
  if (nextPath) {
    draftPath.value = nextPath
  }
}

const confirm = () => {
  closeWithAnimation(() => {
    emit('confirm', {
      outputPath: draftPath.value,
      outputFormat: draftFormat.value,
      outputFilename: draftFilename.value
    })
  })
}

const cancel = () => {
  closeWithAnimation(() => {
    emit('cancel')
  })
}
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      style="width: 480px; height: 280px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.outputDialogTitle') }}</span>
      </div>
      <div class="dialog-body">
        <div class="form-row">
          <div class="form-label">{{ t('mixtape.outputPath') }}：</div>
          <div class="form-field">
            <div
              class="chooseDirDiv"
              :class="{ 'chooseDirDiv--empty': !draftPath }"
              :title="outputPathDisplay"
              @click="handlePickOutputPath"
            >
              {{ outputPathDisplay }}
            </div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('mixtape.outputFormat') }}：</div>
          <div class="form-field">
            <BaseSelect v-model="draftFormat" :options="formatOptions" :width="140" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('mixtape.outputFilename') }}：</div>
          <div class="form-field">
            <input v-model="draftFilename" class="dialog-input" type="text" />
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="confirm">{{ t('mixtape.outputAction') }}</div>
        <div class="button" @click="cancel">{{ t('common.cancel') }}</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dialog-body {
  padding: 16px 20px 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-label {
  width: 90px;
  text-align: left;
  font-size: 13px;
  color: var(--text-weak);
}

.form-field {
  flex: 1;
}

.dialog-input {
  width: 100%;
  height: 25px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  padding: 0 8px;
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

.chooseDirDiv {
  width: 100%;
  height: 25px;
  line-height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 13px;
  padding-left: 6px;
  border-radius: 3px;
  box-sizing: border-box;
  cursor: pointer;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.chooseDirDiv--empty {
  color: var(--text-weak);
}
</style>
