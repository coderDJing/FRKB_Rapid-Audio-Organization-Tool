<script setup lang="ts">
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseBandKey } from '@renderer/components/useHorizontalBrowseFaderControls'

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
</script>

<template>
  <div class="deck-band-controls">
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
  padding: 0 4px;
}

.deck-band-controls__button {
  width: 32px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--shell-border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--shell-panel) 86%, var(--bg-elev));
  color: var(--text-weak);
  font-size: 10px;
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
</style>
