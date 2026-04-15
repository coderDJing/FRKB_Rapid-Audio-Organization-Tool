<script setup lang="ts">
import BeatGridMetronomeControls from '@renderer/components/BeatGridMetronomeControls.vue'
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
  loopBeatLabel: string
  loopActive: boolean
  loopDisabled: boolean
  songPresent: boolean
  readOnlySource: boolean
  masterTempoEnabled: boolean
  metronomeEnabled: boolean
  metronomeVolumeLevel: 1 | 2 | 3
  canToggleMetronome: boolean
  canAdjustMetronomeVolume: boolean
}>()

const emit = defineEmits<{
  (event: 'set-bar-line'): void
  (event: 'shift-left-large'): void
  (event: 'shift-left-small'): void
  (event: 'shift-right-small'): void
  (event: 'shift-right-large'): void
  (event: 'update-bpm-input', value: string): void
  (event: 'blur-bpm-input'): void
  (event: 'memory-cue'): void
  (event: 'toggle-bar-line-picking'): void
  (event: 'loop-step-down'): void
  (event: 'loop-step-up'): void
  (event: 'toggle-loop'): void
  (event: 'toggle-master-tempo'): void
  (event: 'reset-tempo'): void
  (event: 'toggle-metronome'): void
  (event: 'cycle-metronome-volume'): void
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
        :show-tap-button="false"
        show-memory-button
        @set-bar-line="emit('set-bar-line')"
        @shift-left-large="emit('shift-left-large')"
        @shift-left-small="emit('shift-left-small')"
        @shift-right-small="emit('shift-right-small')"
        @shift-right-large="emit('shift-right-large')"
        @update-bpm-input="emit('update-bpm-input', $event)"
        @blur-bpm-input="emit('blur-bpm-input')"
        @memory-cue="emit('memory-cue')"
      />
      <div class="overview__toolbar-group overview__loop-control">
        <button
          type="button"
          class="overview__loop-arrow"
          :disabled="props.loopDisabled"
          title="Loop 缩短"
          aria-label="Loop 缩短"
          @click="emit('loop-step-down')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M10.5 3.5 6 8l4.5 4.5"></path>
          </svg>
        </button>
        <button
          type="button"
          class="overview__loop-value"
          :class="{ 'is-active': props.loopActive }"
          :disabled="props.loopDisabled"
          title="Toggle Loop"
          aria-label="Toggle Loop"
          @click="emit('toggle-loop')"
        >
          {{ props.loopBeatLabel }}
        </button>
        <button
          type="button"
          class="overview__loop-arrow"
          :disabled="props.loopDisabled"
          title="Loop 加长"
          aria-label="Loop 加长"
          @click="emit('loop-step-up')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M5.5 3.5 10 8l-4.5 4.5"></path>
          </svg>
        </button>
      </div>
      <div class="overview__toolbar-group">
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
      <div class="overview__toolbar-group">
        <BeatGridMetronomeControls
          :metronome-enabled="props.metronomeEnabled"
          :metronome-volume-level="props.metronomeVolumeLevel"
          :can-toggle-metronome="props.canToggleMetronome"
          :can-adjust-metronome-volume="props.canAdjustMetronomeVolume"
          @toggle-metronome="emit('toggle-metronome')"
          @cycle-metronome-volume="emit('cycle-metronome-volume')"
        />
      </div>
    </div>
    <div class="overview__toolbar-actions">
      <button
        type="button"
        class="overview__transport-btn"
        :class="{ 'is-active': props.masterTempoEnabled }"
        :disabled="!props.songPresent"
        title="Master Tempo"
        @click="emit('toggle-master-tempo')"
      >
        MT
      </button>
      <button
        type="button"
        class="overview__transport-btn"
        :disabled="!props.songPresent"
        title="Reset Tempo"
        @click="emit('reset-tempo')"
      >
        RES
      </button>
      <HorizontalBrowseDeckMoveButton
        :disabled="!props.songPresent"
        :read-only-source="props.readOnlySource"
        @select-target="emit('select-move-target', $event)"
      />
    </div>
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
  padding: 0 8px;
  box-sizing: border-box;
}

.overview__toolbar-main {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.overview__toolbar-group {
  display: inline-flex;
  align-items: center;
}

.overview__toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.overview__loop-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.overview__loop-arrow,
.overview__loop-value {
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.overview__loop-arrow {
  width: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.overview__loop-arrow svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.overview__loop-value {
  min-width: 44px;
  padding: 0 9px;
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.overview__loop-arrow:hover:not(:disabled),
.overview__loop-value:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__loop-value.is-active {
  color: var(--shell-cue-accent, #d98921);
  border-color: color-mix(in srgb, var(--shell-cue-accent, #d98921) 72%, var(--border));
  background: color-mix(in srgb, var(--shell-cue-accent, #d98921) 12%, var(--bg-elev));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--shell-cue-accent, #d98921) 22%, transparent);
}

.overview__loop-arrow:disabled,
.overview__loop-value:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.overview__set-bar-btn {
  height: 22px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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

.overview__transport-btn {
  height: 22px;
  min-width: 34px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  letter-spacing: 0;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.overview__transport-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__transport-btn.is-active {
  color: #ffffff;
  border-color: rgba(42, 144, 255, 0.95);
  background: linear-gradient(180deg, rgba(35, 137, 255, 0.96), rgba(0, 120, 212, 0.96));
  box-shadow:
    0 0 0 1px rgba(12, 84, 156, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.24);
}

.overview__transport-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
