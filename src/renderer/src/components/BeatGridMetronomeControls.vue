<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'

const props = defineProps({
  metronomeEnabled: {
    type: Boolean,
    default: false
  },
  metronomeVolumeLevel: {
    type: Number,
    default: 2
  },
  canToggleMetronome: {
    type: Boolean,
    default: false
  },
  canAdjustMetronomeVolume: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits<{
  (event: 'toggle-metronome'): void
  (event: 'cycle-metronome-volume'): void
}>()

const metronomeTitle = computed(() =>
  props.metronomeEnabled ? t('mixtape.metronomeOn') : t('mixtape.metronomeOff')
)

const metronomeVolumeTitle = computed(() =>
  t('mixtape.metronomeVolumeLevel', { level: props.metronomeVolumeLevel })
)
</script>

<template>
  <div class="metronome-controls">
    <button
      class="waveform-action-btn"
      type="button"
      :class="{ 'is-active': metronomeEnabled }"
      :disabled="!canToggleMetronome"
      :title="metronomeTitle"
      :aria-label="metronomeTitle"
      @click="emit('toggle-metronome')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 2h7l-1.2 11h-4.6L4.5 2Z"></path>
        <path d="M8 5.3v3.8"></path>
        <circle cx="8" cy="10.9" r="1.1"></circle>
      </svg>
      <span>{{ t('mixtape.metronome') }}</span>
    </button>
    <button
      class="metronome-volume-btn"
      type="button"
      :disabled="!canAdjustMetronomeVolume"
      :title="metronomeVolumeTitle"
      :aria-label="metronomeVolumeTitle"
      @click="emit('cycle-metronome-volume')"
    >
      {{ metronomeVolumeLevel }}/3
    </button>
  </div>
</template>

<style scoped lang="scss">
.metronome-controls {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.waveform-action-btn,
.metronome-volume-btn {
  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: none;
    box-shadow: none;
  }
}

.waveform-action-btn {
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.waveform-action-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.waveform-action-btn svg path:first-child {
  fill: currentColor;
  stroke: none;
  opacity: 0.18;
}

.waveform-action-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.waveform-action-btn:disabled,
.metronome-volume-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.waveform-action-btn.is-active {
  border-color: rgba(145, 205, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(145, 205, 255, 0.25) inset;
  background: rgba(145, 205, 255, 0.12);
}

.metronome-volume-btn {
  height: 22px;
  min-width: 42px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.metronome-volume-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}
</style>
