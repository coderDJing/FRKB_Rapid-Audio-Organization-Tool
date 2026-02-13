<script setup lang="ts">
import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'

const props = defineProps({
  trackTitle: {
    type: String,
    default: ''
  },
  bpm: {
    type: Number,
    default: 128
  },
  firstBeatMs: {
    type: Number,
    default: 0
  },
  masterTempo: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits<{
  (event: 'confirm', payload: { bpm: number; firstBeatMs: number; masterTempo: boolean }): void
  (event: 'cancel'): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const draftBpm = ref(props.bpm)
const draftFirstBeatMs = ref(props.firstBeatMs)
const draftMasterTempo = ref(props.masterTempo)

const confirm = () => {
  closeWithAnimation(() => {
    emit('confirm', {
      bpm: Number(draftBpm.value) || 0,
      firstBeatMs: Number(draftFirstBeatMs.value) || 0,
      masterTempo: !!draftMasterTempo.value
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
      style="width: 420px; height: 260px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.beatAlignDialogTitle') }}</span>
      </div>
      <div class="dialog-body">
        <div v-if="trackTitle" class="track-name" :title="trackTitle">
          {{ trackTitle }}
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('mixtape.bpm') }}：</div>
          <div class="form-field">
            <input
              v-model.number="draftBpm"
              class="dialog-input"
              type="number"
              min="30"
              max="300"
              step="0.1"
            />
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('mixtape.firstBeatOffset') }}：</div>
          <div class="form-field form-field-inline">
            <input v-model.number="draftFirstBeatMs" class="dialog-input" type="number" step="1" />
            <span class="unit">ms</span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ t('mixtape.masterTempo') }}：</div>
          <div class="form-field">
            <singleCheckbox v-model="draftMasterTempo" />
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="confirm">{{ t('common.confirm') }}</div>
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

.track-name {
  font-size: 12px;
  color: var(--text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.form-field-inline {
  display: flex;
  align-items: center;
  gap: 8px;
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

.unit {
  font-size: 12px;
  color: var(--text-weak);
}
</style>
