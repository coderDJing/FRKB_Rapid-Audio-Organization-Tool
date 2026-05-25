<script setup lang="ts">
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseBandKey } from '@renderer/components/useHorizontalBrowseFaderControls'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useHorizontalBrowseAutoGain } from '@renderer/components/useHorizontalBrowseAutoGain'

type HorizontalBrowseBandState = Record<HorizontalBrowseBandKey, boolean>

const props = defineProps<{
  deck: HorizontalBrowseDeckKey
  bands: HorizontalBrowseBandState
}>()

const emit = defineEmits<{
  (event: 'toggle-band', deck: HorizontalBrowseDeckKey, band: HorizontalBrowseBandKey): void
}>()

const bandLabels: Record<HorizontalBrowseBandKey, string> = {
  high: 'HI',
  mid: 'MID',
  low: 'LOW'
}

const bandKeys: HorizontalBrowseBandKey[] = ['high', 'mid', 'low']
const { autoGainEnabled, autoGainStatus, autoGainTitle, toggleAutoGain } =
  useHorizontalBrowseAutoGain(props.deck)
</script>

<template>
  <div class="deck-band-controls">
    <bubbleBoxTrigger
      wrapper-tag="span"
      tag="button"
      class="deck-band-controls__button deck-band-controls__button--auto-gain"
      :class="[
        `is-auto-gain-${autoGainStatus}`,
        {
          'is-active': autoGainEnabled && autoGainStatus !== 'off',
          'is-pending': autoGainStatus === 'pending',
          'is-unavailable': autoGainStatus === 'unavailable'
        }
      ]"
      type="button"
      :title="autoGainTitle"
      :aria-pressed="autoGainEnabled"
      :aria-label="autoGainTitle"
      @click.stop="toggleAutoGain"
    >
      A.Gain
    </bubbleBoxTrigger>
    <button
      v-for="band in bandKeys"
      :key="band"
      class="deck-band-controls__button"
      :class="[`deck-band-controls__button--${band}`, { 'is-active': props.bands[band] }]"
      type="button"
      :aria-pressed="props.bands[band]"
      :aria-label="`${bandLabels[band]} ${props.bands[band] ? '已激活' : '已削减'}`"
      @click.stop="emit('toggle-band', props.deck, band)"
    >
      {{ bandLabels[band] }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.deck-band-controls {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  min-width: 0;
  box-sizing: border-box;
  padding: 0 5px 0 2px;
}

.deck-band-controls__button {
  width: 32px;
  height: 17px;
  padding: 0;
  border: 1px solid var(--shell-border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--shell-panel) 86%, var(--bg-elev));
  color: var(--text-weak);
  font-size: 9px;
  font-weight: 600;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.1s ease;
}

.deck-band-controls__button:hover {
  border-color: color-mix(in srgb, var(--text-weak) 42%, var(--shell-border));
  color: var(--text);
}

.deck-band-controls__button--auto-gain {
  font-size: 7px;
}

.deck-band-controls__button--auto-gain.is-active:not(.is-unavailable) {
  --band-color: #f59e0b;
}

.deck-band-controls__button--auto-gain.is-pending {
  animation: deck-auto-gain-pulse 1.1s ease-in-out infinite;
}

.deck-band-controls__button--auto-gain.is-unavailable {
  border-color: color-mix(in srgb, #ef4444 58%, var(--shell-border));
  background: color-mix(in srgb, #ef4444 8%, var(--shell-panel));
  color: color-mix(in srgb, #ef4444 74%, var(--text));
}

.deck-band-controls__button--high.is-active {
  --band-color: #3b82f6; /* Blue */
}

.deck-band-controls__button--mid.is-active {
  --band-color: #10b981; /* Green */
}

.deck-band-controls__button--low.is-active {
  --band-color: #ef4444; /* Red */
}

.deck-band-controls__button.is-active {
  border-color: color-mix(in srgb, var(--band-color) 70%, transparent);
  background: color-mix(in srgb, var(--band-color) 15%, transparent);
  color: color-mix(in srgb, var(--band-color) 90%, #fff);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 15%, transparent);
}

@keyframes deck-auto-gain-pulse {
  0%,
  100% {
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 15%, transparent);
  }

  50% {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent),
      0 0 0 1px color-mix(in srgb, #f59e0b 28%, transparent);
  }
}
</style>
