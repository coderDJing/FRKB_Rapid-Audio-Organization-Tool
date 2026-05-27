<script setup lang="ts">
import { ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import HorizontalBrowseRawWaveformDetail from '@renderer/components/HorizontalBrowseRawWaveformDetail.vue'
import type {
  HorizontalBrowseGridShiftOptions,
  HorizontalBrowseGridToolbarState
} from '@renderer/components/useHorizontalBrowseGridToolbar'
import type { HorizontalBrowseRawWaveformDetailExpose } from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'

type HorizontalBrowseSharedZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

const props = defineProps<{
  song: ISongInfo | null
  sharedZoomState: HorizontalBrowseSharedZoomState
  currentSeconds: number
  playing: boolean
  playbackActive: boolean
  playbackRate: number
  visualPlaybackRate?: number
  playbackSyncRevision: number
  gridBpm: number
  loopRange: HorizontalBrowseLoopRange | null
  cueSeconds: number
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
  deferWaveformLoad: boolean
  rawLoadPriorityHint: number
  seekTargetSeconds: number
  seekRevision: number
  direction: 'up' | 'down'
  maxZoom?: number
  waveformLayout?: 'auto' | 'full'
  waveformRenderStyle?: 'columns' | 'raw-curve'
  allowNegativeTimeline?: boolean
  deckHovered: boolean
  regionId: number
}>()

const emit = defineEmits<{
  (event: 'region-drag-enter', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-over', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-leave', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drop', regionId: number, dragEvent: DragEvent): void
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (
    event: 'zoom-change',
    value: { value: number; anchorRatio: number; sourceDirection: 'up' | 'down' }
  ): void
  (event: 'drag-session-start'): void
  (event: 'drag-session-preview', payload: { anchorSec: number; playbackRate: number }): void
  (event: 'drag-session-end', payload: { anchorSec: number; committed: boolean }): void
}>()

const detailRef = ref<HorizontalBrowseRawWaveformDetailExpose | null>(null)

defineExpose<HorizontalBrowseRawWaveformDetailExpose>({
  toggleBarLinePicking: () => detailRef.value?.toggleBarLinePicking?.(),
  setBarLineAtPlayhead: () => detailRef.value?.setBarLineAtPlayhead?.(),
  shiftGridLargeLeft: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridLargeLeft?.(options),
  shiftGridSmallLeft: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridSmallLeft?.(options),
  shiftGridSmallRight: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridSmallRight?.(options),
  shiftGridLargeRight: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridLargeRight?.(options),
  updateBpmInput: (value: string) => detailRef.value?.updateBpmInput?.(value),
  blurBpmInput: () => detailRef.value?.blurBpmInput?.(),
  tapBpm: () => detailRef.value?.tapBpm?.(),
  cycleMetronomeState: () => detailRef.value?.cycleMetronomeState?.()
})
</script>

<template>
  <div
    class="detail-lane drop-zone"
    :class="{ 'is-deck-hover': props.deckHovered }"
    @dragenter.stop.prevent="emit('region-drag-enter', props.regionId, $event)"
    @dragover.stop.prevent="emit('region-drag-over', props.regionId, $event)"
    @dragleave.stop="emit('region-drag-leave', props.regionId, $event)"
    @drop.stop.prevent="emit('region-drop', props.regionId, $event)"
  >
    <HorizontalBrowseRawWaveformDetail
      ref="detailRef"
      :song="props.song"
      :shared-zoom-state="props.sharedZoomState"
      :current-seconds="props.currentSeconds"
      :playing="props.playing"
      :playback-active="props.playbackActive"
      :playback-rate="props.playbackRate"
      :visual-playback-rate="props.visualPlaybackRate"
      :playback-sync-revision="props.playbackSyncRevision"
      :grid-bpm="props.gridBpm"
      :loop-range="props.loopRange"
      :cue-seconds="props.cueSeconds"
      :hot-cues="props.hotCues"
      :memory-cues="props.memoryCues"
      :defer-waveform-load="props.deferWaveformLoad"
      :raw-load-priority-hint="props.rawLoadPriorityHint"
      :seek-target-seconds="props.seekTargetSeconds"
      :seek-revision="props.seekRevision"
      :max-zoom="props.maxZoom"
      :waveform-layout="props.waveformLayout"
      :waveform-render-style="props.waveformRenderStyle"
      :allow-negative-timeline="props.allowNegativeTimeline"
      :direction="props.direction"
      @toolbar-state-change="emit('toolbar-state-change', $event)"
      @zoom-change="emit('zoom-change', $event)"
      @drag-session-start="emit('drag-session-start')"
      @drag-session-preview="emit('drag-session-preview', $event)"
      @drag-session-end="emit('drag-session-end', $event)"
    />
    <div
      v-show="!!props.song"
      class="detail-lane__playhead"
      :class="{ 'is-paused': !props.playing }"
    ></div>
  </div>
</template>

<style scoped lang="scss">
.detail-lane__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--shell-playhead-bg);
  pointer-events: none;
  z-index: 6;
}

.detail-lane__playhead.is-paused {
  opacity: 0.7;
}
</style>
