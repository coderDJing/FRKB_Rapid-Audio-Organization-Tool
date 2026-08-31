<script setup lang="ts">
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

defineProps<{
  mode: 'audio' | 'grid'
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:mode', value: 'audio' | 'grid'): void
}>()
</script>

<template>
  <div class="edit-submode" role="tablist" :aria-label="t('audioEdit.audioMode')">
    <bubbleBoxTrigger
      wrapper-tag="span"
      wrapper-class="edit-submode__anchor"
      tag="button"
      type="button"
      role="tab"
      class="edit-submode__button"
      :class="{ 'is-active': mode === 'audio' }"
      :disabled="disabled"
      :title="t('audioEdit.audioMode')"
      :aria-label="t('audioEdit.audioMode')"
      :aria-selected="mode === 'audio'"
      @click="emit('update:mode', 'audio')"
    >
      {{ t('audioEdit.audioModeShort') }}
    </bubbleBoxTrigger>
    <bubbleBoxTrigger
      wrapper-tag="span"
      wrapper-class="edit-submode__anchor"
      tag="button"
      type="button"
      role="tab"
      class="edit-submode__button"
      :class="{ 'is-active': mode === 'grid' }"
      :disabled="disabled"
      :title="t('audioEdit.gridMode')"
      :aria-label="t('audioEdit.gridMode')"
      :aria-selected="mode === 'grid'"
      @click="emit('update:mode', 'grid')"
    >
      {{ t('audioEdit.gridModeShort') }}
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.edit-submode {
  display: inline-flex;
  align-items: stretch;
  flex: 0 0 auto;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-elev);
}

.edit-submode__anchor {
  display: inline-flex;
  height: 100%;
}

.edit-submode__anchor + .edit-submode__anchor {
  border-left: 1px solid var(--border);
}

.edit-submode__button {
  height: 100%;
  min-width: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-weak);
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  cursor: pointer;
}

.edit-submode__button.is-active {
  color: var(--shell-active-control-text, #fff);
  background: var(--shell-active-control-bg, var(--accent));
}

.edit-submode__button:hover:not(:disabled):not(.is-active) {
  color: var(--text);
  background: var(--hover);
}

.edit-submode__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
