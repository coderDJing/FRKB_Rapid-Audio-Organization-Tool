<script setup lang="ts">
import MixtapeBeatAlignGridAdjustToolbar from '@renderer/components/mixtapeBeatAlignGridAdjustToolbar.vue'
import HorizontalBrowseDeckMoveButton from '@renderer/components/HorizontalBrowseDeckMoveButton.vue'
import type { HorizontalBrowseDeckMoveTargetLibrary } from '@renderer/components/useHorizontalBrowseDeckMove'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  disabled: boolean
  bpmInputValue: string
  bpmStep: number
  bpmMin: number
  bpmMax: number
  barLinePicking: boolean
  songPresent: boolean
  readOnlySource: boolean
}>()

const emit = defineEmits<{
  (event: 'set-bar-line'): void
  (event: 'shift-left-large'): void
  (event: 'shift-left-small'): void
  (event: 'shift-right-small'): void
  (event: 'shift-right-large'): void
  (event: 'update-bpm-input', value: string): void
  (event: 'blur-bpm-input'): void
  (event: 'tap-bpm'): void
  (event: 'toggle-bar-line-picking'): void
  (event: 'select-move-target', target: HorizontalBrowseDeckMoveTargetLibrary): void
}>()
</script>

<template>
  <div class="overview__toolbar-row">
    <div class="overview__toolbar-main">
      <MixtapeBeatAlignGridAdjustToolbar
        :disabled="props.disabled"
        :bpm-input-value="props.bpmInputValue"
        :bpm-step="props.bpmStep"
        :bpm-min="props.bpmMin"
        :bpm-max="props.bpmMax"
        @set-bar-line="emit('set-bar-line')"
        @shift-left-large="emit('shift-left-large')"
        @shift-left-small="emit('shift-left-small')"
        @shift-right-small="emit('shift-right-small')"
        @shift-right-large="emit('shift-right-large')"
        @update-bpm-input="emit('update-bpm-input', $event)"
        @blur-bpm-input="emit('blur-bpm-input')"
        @tap-bpm="emit('tap-bpm')"
      />
      <button
        type="button"
        class="overview__set-bar-btn"
        :class="{ 'is-active': props.barLinePicking }"
        :disabled="props.disabled"
        @click="emit('toggle-bar-line-picking')"
      >
        {{
          props.barLinePicking
            ? t('mixtape.gridAdjustSetBarLineCancel')
            : t('mixtape.gridAdjustSetBarLine')
        }}
      </button>
    </div>
    <HorizontalBrowseDeckMoveButton
      :disabled="!props.songPresent"
      :read-only-source="props.readOnlySource"
      @select-target="emit('select-move-target', $event)"
    />
  </div>
</template>

<style scoped lang="scss">
.overview__toolbar-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 24px 0 8px;
  box-sizing: border-box;
}

.overview__toolbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.overview__set-bar-btn {
  height: 24px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  line-height: 22px;
  white-space: nowrap;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease;
}

.overview__set-bar-btn:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__set-bar-btn.is-active {
  border-color: rgba(145, 205, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(145, 205, 255, 0.25) inset;
  background: rgba(145, 205, 255, 0.12);
}

.overview__set-bar-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
