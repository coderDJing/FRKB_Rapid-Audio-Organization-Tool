<script setup lang="ts">
import { computed } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  normalizeSongStructureAnalysis,
  type SongStructureSection,
  type SongStructureSectionKind
} from '@shared/songStructure'

const props = defineProps<{
  song: ISongInfo | null
  currentSeconds: number
  durationSeconds: number
}>()

const emit = defineEmits<{
  (event: 'seek-play', seconds: number): void
}>()

const resolveStructureLabel = (kind: SongStructureSectionKind) => {
  if (kind === 'breakdown') return 'BREAK'
  return kind.toUpperCase()
}

const structureSections = computed(() => {
  const structure = normalizeSongStructureAnalysis(props.song?.songStructure)
  const structureDuration = Math.max(0, Number(structure?.durationSec) || 0)
  const totalSeconds = structureDuration || Math.max(0, Number(props.durationSeconds) || 0)
  if (!props.song || !structure || totalSeconds <= 0) return []
  return structure.sections
    .map((section: SongStructureSection) => {
      const startSec = Math.max(0, Math.min(totalSeconds, Number(section.startSec) || 0))
      const endSec = Math.max(startSec, Math.min(totalSeconds, Number(section.endSec) || 0))
      if (endSec - startSec <= 0.2) return null
      return {
        key: `${section.phraseIndex}-${section.kind}-${section.startSec}-${section.endSec}`,
        kind: section.kind,
        label: resolveStructureLabel(section.kind),
        startSec,
        active:
          props.currentSeconds >= startSec && props.currentSeconds < Math.max(endSec, startSec),
        style: {
          left: `${(startSec / totalSeconds) * 100}%`,
          width: `${((endSec - startSec) / totalSeconds) * 100}%`,
          '--structure-strength': String(Math.max(0.36, Math.min(0.76, section.confidence)))
        } as Record<string, string>
      }
    })
    .filter(
      (
        section
      ): section is {
        key: string
        kind: SongStructureSectionKind
        label: string
        startSec: number
        active: boolean
        style: Record<string, string>
      } => section !== null
    )
})
</script>

<template>
  <div
    class="player-structure-rail"
    :class="{ 'player-structure-rail--empty': !structureSections.length }"
  >
    <button
      v-for="section in structureSections"
      :key="section.key"
      type="button"
      class="player-structure-rail__segment"
      :aria-label="`Seek to ${section.label}`"
      :class="[
        `player-structure-rail__segment--${section.kind}`,
        { 'player-structure-rail__segment--active': section.active }
      ]"
      :style="section.style"
      @click.stop="emit('seek-play', section.startSec)"
    >
      <span class="player-structure-rail__label">{{ section.label }}</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
.player-structure-rail {
  --structure-intro: rgba(125, 211, 252, 0.74);
  --structure-groove: rgba(52, 211, 153, 0.72);
  --structure-breakdown: rgba(196, 181, 253, 0.74);
  --structure-build: rgba(251, 191, 36, 0.76);
  --structure-drop: rgba(248, 113, 113, 0.78);
  --structure-outro: rgba(148, 163, 184, 0.68);
  position: relative;
  flex: 0 0 8px;
  width: 100%;
  height: 8px;
  overflow: hidden;
  border-radius: 0;
  background: color-mix(in srgb, var(--waveform-bg) 86%, var(--border));
  pointer-events: auto;
}

.player-structure-rail--empty {
  visibility: hidden;
  pointer-events: none;
}

.player-structure-rail__segment {
  position: absolute;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 8px;
  min-width: 3px;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  padding: 0;
  appearance: none;
  opacity: var(--structure-strength, 0.62);
  background: var(--structure-groove);
  cursor: pointer;
  box-shadow:
    inset 1px 0 0 rgba(255, 255, 255, 0.34),
    inset -1px 0 0 rgba(0, 0, 0, 0.18),
    0 1px 2px rgba(0, 0, 0, 0.2);
}

.player-structure-rail__segment:focus-visible {
  outline: none;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.72),
    0 0 0 1px rgba(0, 0, 0, 0.34);
}

.player-structure-rail__segment--active {
  opacity: min(1, calc(var(--structure-strength, 0.62) + 0.24));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.44),
    0 0 0 1px rgba(255, 255, 255, 0.16),
    0 1px 4px rgba(0, 0, 0, 0.32);
}

.player-structure-rail__label {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  padding: 0 4px;
  color: rgba(12, 18, 28, 0.9);
  font-size: 7px;
  font-weight: 800;
  line-height: 8px;
  text-align: center;
  text-overflow: clip;
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.26);
  white-space: nowrap;
  pointer-events: none;
}

.player-structure-rail__segment--intro {
  background: var(--structure-intro);
}

.player-structure-rail__segment--groove {
  background: var(--structure-groove);
}

.player-structure-rail__segment--breakdown {
  background: var(--structure-breakdown);
}

.player-structure-rail__segment--build {
  background: var(--structure-build);
}

.player-structure-rail__segment--drop {
  background: var(--structure-drop);
}

.player-structure-rail__segment--outro {
  background: var(--structure-outro);
}

:global(.theme-light) .player-structure-rail {
  --structure-intro: rgba(2, 132, 199, 0.58);
  --structure-groove: rgba(5, 150, 105, 0.58);
  --structure-breakdown: rgba(124, 58, 237, 0.56);
  --structure-build: rgba(217, 119, 6, 0.6);
  --structure-drop: rgba(220, 38, 38, 0.62);
  --structure-outro: rgba(71, 85, 105, 0.54);
}

:global(.theme-light) .player-structure-rail__label {
  color: rgba(255, 255, 255, 0.96);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.24);
}
</style>
