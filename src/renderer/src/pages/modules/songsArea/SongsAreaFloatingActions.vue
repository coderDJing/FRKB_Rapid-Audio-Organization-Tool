<script setup lang="ts">
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import PlaylistAnalysisFloatingButton from './PlaylistAnalysisFloatingButton.vue'
import type { SongsAreaDeckLocateTarget } from './composables/useSongsAreaDeckLocate'

defineProps<{
  deckTargets: SongsAreaDeckLocateTarget[]
  showPlaying: boolean
  analysisVisible: boolean
  analysisPending: boolean
}>()
const emit = defineEmits<{
  locate: [deck: 'top' | 'bottom']
  playing: []
  analyze: []
}>()
</script>

<template>
  <div
    v-if="showPlaying || deckTargets.length || analysisVisible"
    class="songs-area-floating-actions"
  >
    <PlaylistAnalysisFloatingButton
      v-if="analysisVisible"
      :pending="analysisPending"
      @analyze="emit('analyze')"
    />
    <bubbleBoxTrigger
      v-if="showPlaying"
      tag="button"
      class="songs-area-float-jump"
      type="button"
      :title="t('tracks.locateCurrentSong')"
      :aria-label="t('tracks.locateCurrentSong')"
      @click.stop="emit('playing')"
    >
      <span class="songs-area-float-jump__icon" aria-hidden="true"></span>
    </bubbleBoxTrigger>
    <bubbleBoxTrigger
      v-for="target in deckTargets"
      :key="target.deck"
      tag="button"
      class="songs-area-float-jump songs-area-float-jump--deck"
      type="button"
      :title="t(target.deck === 'top' ? 'tracks.locateTopDeckHint' : 'tracks.locateBottomDeckHint')"
      :aria-label="t(target.deck === 'top' ? 'tracks.locateTopDeck' : 'tracks.locateBottomDeck')"
      @click.stop="emit('locate', target.deck)"
    >
      <span class="songs-area-float-jump__icon" aria-hidden="true"></span>
      <span>{{
        t(target.deck === 'top' ? 'tracks.locateTopDeck' : 'tracks.locateBottomDeck')
      }}</span>
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.songs-area-floating-actions {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  max-width: calc(100% - 24px);
}

.songs-area-float-jump {
  width: 28px;
  height: 28px;
  padding: 0;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  opacity: 0.65;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18);

  &:hover {
    opacity: 0.95;
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
    outline-offset: 2px;
  }
}

.songs-area-float-jump--deck {
  width: auto;
  gap: 5px;
  padding: 0 9px;
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.songs-area-float-jump__icon {
  position: relative;
  width: 14px;
  height: 14px;
  flex-shrink: 0;

  &::before,
  &::after {
    content: '';
    position: absolute;
    background: var(--text);
  }

  &::before {
    width: 2px;
    height: 12px;
    left: 6px;
    top: 1px;
    border-radius: 1px;
    opacity: 0.85;
  }

  &::after {
    width: 6px;
    height: 6px;
    left: 4px;
    top: 4px;
    border-radius: 50%;
    opacity: 0.9;
  }
}
</style>
