<script setup lang="ts">
const props = defineProps<{
  playing: boolean
  decoding?: boolean
  pendingPlay?: boolean
  pendingCue?: boolean
}>()

const emit = defineEmits<{
  (event: 'cue-pointer-down', pointerEvent: PointerEvent): void
  (event: 'cue-click'): void
  (event: 'play-toggle'): void
}>()
</script>

<template>
  <div class="deck-controls">
    <button
      type="button"
      class="deck-button deck-button--cue"
      :class="{ 'is-pending': props.pendingCue, 'is-decoding': props.decoding }"
      @pointerdown="emit('cue-pointer-down', $event)"
      @click="emit('cue-click')"
    >
      CUE
    </button>
    <button
      type="button"
      class="deck-button deck-button--play"
      :class="{
        'is-active': props.playing,
        'is-pending': props.pendingPlay,
        'is-decoding': props.decoding
      }"
      @click="emit('play-toggle')"
    >
      <svg v-if="props.playing" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="4.25" y="3.5" width="2.75" height="9"></rect>
        <rect x="9" y="3.5" width="2.75" height="9"></rect>
      </svg>
      <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
      </svg>
    </button>
  </div>
</template>

<style scoped lang="scss">
.deck-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.deck-button {
  width: 36px;
  height: 36px;
  border: 1px solid var(--shell-border, var(--border));
  border-radius: 50%;
  background: transparent;
  color: var(--text-weak);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  box-sizing: border-box;
  outline: none;
  appearance: none;
  -webkit-tap-highlight-color: transparent;
}

.deck-button--cue {
  color: var(--shell-cue-accent, #d98921);
}

.deck-button--play {
  color: var(--shell-play, #9fd6b3);
}

.deck-button--play.is-active {
  border-color: rgba(122, 194, 145, 0.72);
  background: rgba(122, 194, 145, 0.12);
  box-shadow: inset 0 0 0 1px rgba(122, 194, 145, 0.08);
}

.deck-button.is-pending {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--shell-border, var(--border)));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
}

.deck-button.is-decoding {
  opacity: 0.82;
}

.deck-button:focus,
.deck-button:focus-visible {
  outline: none;
}

.deck-button:focus-visible {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent),
    0 0 0 2px color-mix(in srgb, var(--accent) 36%, transparent);
}

.deck-button svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

@media (max-width: 1080px) {
  .deck-button {
    width: 34px;
    height: 34px;
  }
}
</style>
