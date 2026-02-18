<script setup lang="ts">
import { t } from '@renderer/utils/translate'

const props = defineProps({
  previewDecoding: {
    type: Boolean,
    default: false
  },
  previewPlaying: {
    type: Boolean,
    default: false
  },
  canTogglePreviewPlayback: {
    type: Boolean,
    default: false
  },
  canStopPreviewPlayback: {
    type: Boolean,
    default: false
  },
  canAdjustGrid: {
    type: Boolean,
    default: false
  },
  previewBarLinePicking: {
    type: Boolean,
    default: false
  },
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
  (event: 'toggle-playback'): void
  (event: 'stop-to-start'): void
  (event: 'toggle-barline-pick'): void
  (event: 'toggle-metronome'): void
  (event: 'cycle-metronome-volume'): void
}>()

const resolveMetronomeTitle = () =>
  props.metronomeEnabled ? t('mixtape.metronomeOn') : t('mixtape.metronomeOff')

const resolveMetronomeVolumeTitle = () =>
  t('mixtape.metronomeVolumeLevel', { level: props.metronomeVolumeLevel })
</script>

<template>
  <div class="preview-toolbar">
    <div class="preview-tools">
      <button
        class="playback-icon-btn"
        type="button"
        :disabled="!canTogglePreviewPlayback"
        :title="
          previewDecoding
            ? t('mixtape.transportDecoding')
            : previewPlaying
              ? t('mixtape.pause')
              : t('mixtape.play')
        "
        :aria-label="
          previewDecoding
            ? t('mixtape.transportDecoding')
            : previewPlaying
              ? t('mixtape.pause')
              : t('mixtape.play')
        "
        @click="emit('toggle-playback')"
      >
        <svg
          v-if="previewDecoding"
          class="is-spinning"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="5.5"></circle>
        </svg>
        <svg v-else-if="previewPlaying" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="4" y="3" width="3" height="10" rx="0.9"></rect>
          <rect x="9" y="3" width="3" height="10" rx="0.9"></rect>
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
        </svg>
      </button>
      <button
        class="playback-icon-btn"
        type="button"
        :disabled="!canStopPreviewPlayback"
        :title="t('mixtape.stop')"
        :aria-label="t('mixtape.stop')"
        @click="emit('stop-to-start')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="4" y="4" width="8" height="8" rx="1"></rect>
        </svg>
      </button>
      <button
        class="barline-btn"
        type="button"
        :class="{ 'is-active': previewBarLinePicking }"
        :disabled="!canAdjustGrid"
        @click="emit('toggle-barline-pick')"
      >
        {{
          previewBarLinePicking
            ? t('mixtape.gridAdjustSetBarLineCancel')
            : t('mixtape.gridAdjustSetBarLine')
        }}
      </button>
      <button
        class="waveform-action-btn"
        type="button"
        :class="{ 'is-active': metronomeEnabled }"
        :disabled="!canToggleMetronome"
        :title="resolveMetronomeTitle()"
        :aria-label="resolveMetronomeTitle()"
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
        :title="resolveMetronomeVolumeTitle()"
        :aria-label="resolveMetronomeVolumeTitle()"
        @click="emit('cycle-metronome-volume')"
      >
        {{ metronomeVolumeLevel }}/3
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.preview-tools {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.playback-icon-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.playback-icon-btn:focus,
.barline-btn:focus,
.waveform-action-btn:focus,
.metronome-volume-btn:focus {
  outline: none;
}

.playback-icon-btn:focus-visible,
.barline-btn:focus-visible,
.waveform-action-btn:focus-visible,
.metronome-volume-btn:focus-visible {
  outline: none;
  box-shadow: none;
}

.playback-icon-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 1.6;
}

.playback-icon-btn svg.is-spinning {
  fill: none;
  stroke-linecap: round;
  stroke-dasharray: 24;
  stroke-dashoffset: 8;
  animation: beat-align-playback-spin 0.9s linear infinite;
}

.playback-icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.playback-icon-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes beat-align-playback-spin {
  to {
    transform: rotate(360deg);
  }
}

.barline-btn {
  min-width: 122px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.barline-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.barline-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.barline-btn.is-active {
  border-color: rgba(145, 205, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(145, 205, 255, 0.25) inset;
  background: rgba(145, 205, 255, 0.12);
}

.waveform-action-btn {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
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

.waveform-action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.waveform-action-btn.is-active {
  border-color: rgba(145, 205, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(145, 205, 255, 0.25) inset;
  background: rgba(145, 205, 255, 0.12);
}

.metronome-volume-btn {
  height: 24px;
  min-width: 42px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.metronome-volume-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.metronome-volume-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
