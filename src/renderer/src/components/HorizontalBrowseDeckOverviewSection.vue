<script setup lang="ts">
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckInfoCard from '@renderer/components/HorizontalBrowseDeckInfoCard.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import HorizontalBrowseDeckToolbarRow from '@renderer/components/HorizontalBrowseDeckToolbarRow.vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseDeckMoveTargetLibrary } from '@renderer/components/useHorizontalBrowseDeckMove'

type DeckToolbarState = {
  disabled: boolean
  bpmInputValue: string
  bpmStep: number
  bpmMin: number
  bpmMax: number
  barLinePicking: boolean
}

const props = defineProps<{
  position: 'top' | 'bottom'
  regionIds: number[]
  deck: HorizontalBrowseDeckKey
  deckHovered: boolean
  song: ISongInfo | null
  beatSyncEnabled: boolean
  beatSyncBlinking: boolean
  masterActive: boolean
  currentSeconds: number
  durationSeconds: number
  toolbarState: DeckToolbarState
  readOnlySource: boolean
  masterTempoEnabled: boolean
}>()

const emit = defineEmits<{
  (event: 'region-drag-enter', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-over', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-leave', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drop', regionId: number, dragEvent: DragEvent): void
  (event: 'trigger-beat-sync'): void
  (event: 'toggle-master'): void
  (event: 'eject-song'): void
  (event: 'seek', seconds: number): void
  (event: 'set-bar-line'): void
  (event: 'shift-left-large'): void
  (event: 'shift-left-small'): void
  (event: 'shift-right-small'): void
  (event: 'shift-right-large'): void
  (event: 'update-bpm-input', value: string): void
  (event: 'blur-bpm-input'): void
  (event: 'tap-bpm'): void
  (event: 'toggle-bar-line-picking'): void
  (event: 'toggle-master-tempo'): void
  (event: 'reset-tempo'): void
  (event: 'select-move-target', target: HorizontalBrowseDeckMoveTargetLibrary): void
}>()

const isTop = props.position === 'top'
</script>

<template>
  <section
    class="overview"
    :class="[
      props.position === 'top' ? 'overview--top' : 'overview--bottom',
      { 'is-deck-hover': props.deckHovered }
    ]"
  >
    <div
      v-for="regionId in props.regionIds"
      :key="regionId"
      class="overview__region drop-zone"
      :class="{
        'overview__region--deck-info': isTop ? regionId === 1 : regionId === 8,
        'overview__region--muted': isTop ? regionId === 3 : regionId === 6,
        'overview__region--toolbar': isTop ? regionId === 3 : regionId === 6
      }"
      @dragenter.stop.prevent="emit('region-drag-enter', regionId, $event)"
      @dragover.stop.prevent="emit('region-drag-over', regionId, $event)"
      @dragleave.stop="emit('region-drag-leave', regionId, $event)"
      @drop.stop.prevent="emit('region-drop', regionId, $event)"
    >
      <HorizontalBrowseDeckInfoCard
        v-if="(isTop && regionId === 1) || (!isTop && regionId === 8)"
        :song="props.song"
        :beat-sync-enabled="props.beatSyncEnabled"
        :beat-sync-blinking="props.beatSyncBlinking"
        :master-active="props.masterActive"
        :current-seconds="props.currentSeconds"
        :duration-seconds="props.durationSeconds"
        @trigger-beat-sync="emit('trigger-beat-sync')"
        @toggle-master="emit('toggle-master')"
        @eject-song="emit('eject-song')"
      />
      <HorizontalBrowseWaveformOverview
        v-else-if="(isTop && regionId === 2) || (!isTop && regionId === 7)"
        :song="props.song"
        :current-seconds="props.currentSeconds"
        :duration-seconds="props.durationSeconds"
        @seek="emit('seek', $event)"
      />
      <HorizontalBrowseDeckToolbarRow
        v-else-if="(isTop && regionId === 3) || (!isTop && regionId === 6)"
        :disabled="props.toolbarState.disabled"
        :bpm-input-value="props.toolbarState.bpmInputValue"
        :bpm-step="props.toolbarState.bpmStep"
        :bpm-min="props.toolbarState.bpmMin"
        :bpm-max="props.toolbarState.bpmMax"
        :bar-line-picking="props.toolbarState.barLinePicking"
        :song-present="!!props.song"
        :read-only-source="props.readOnlySource"
        :master-tempo-enabled="props.masterTempoEnabled"
        @set-bar-line="emit('set-bar-line')"
        @shift-left-large="emit('shift-left-large')"
        @shift-left-small="emit('shift-left-small')"
        @shift-right-small="emit('shift-right-small')"
        @shift-right-large="emit('shift-right-large')"
        @update-bpm-input="emit('update-bpm-input', $event)"
        @blur-bpm-input="emit('blur-bpm-input')"
        @tap-bpm="emit('tap-bpm')"
        @toggle-bar-line-picking="emit('toggle-bar-line-picking')"
        @toggle-master-tempo="emit('toggle-master-tempo')"
        @reset-tempo="emit('reset-tempo')"
        @select-move-target="emit('select-move-target', $event)"
      />
    </div>
  </section>
</template>
