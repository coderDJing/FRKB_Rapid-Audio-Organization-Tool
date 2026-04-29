<script setup lang="ts">
import { ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import HorizontalBrowseRawWaveformDetail from '@renderer/components/HorizontalBrowseRawWaveformDetail.vue'
import type { HorizontalBrowseGridToolbarState } from '@renderer/components/useHorizontalBrowseGridToolbar'

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

type HorizontalBrowseRawWaveformDetailExpose = {
  toggleBarLinePicking: () => void
  setBarLineAtPlayhead: () => void
  shiftGridSmallLeft: () => void
  shiftGridLargeLeft: () => void
  shiftGridSmallRight: () => void
  shiftGridLargeRight: () => void
  updateBpmInput: (value: string) => void
  blurBpmInput: () => void
  tapBpm: () => void
  toggleMetronome: () => void
  cycleMetronomeVolume: () => void
}

const props = defineProps<{
  song: ISongInfo | null
  sharedZoomState: HorizontalBrowseSharedZoomState
  currentSeconds: number
  playing: boolean
  playbackRate: number
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
  (event: 'drag-session-end', payload: { anchorSec: number; committed: boolean }): void
}>()

const detailRef = ref<HorizontalBrowseRawWaveformDetailExpose | null>(null)

defineExpose({
  toggleBarLinePicking: () => detailRef.value?.toggleBarLinePicking?.(),
  setBarLineAtPlayhead: () => detailRef.value?.setBarLineAtPlayhead?.(),
  shiftGridLargeLeft: () => detailRef.value?.shiftGridLargeLeft?.(),
  shiftGridSmallLeft: () => detailRef.value?.shiftGridSmallLeft?.(),
  shiftGridSmallRight: () => detailRef.value?.shiftGridSmallRight?.(),
  shiftGridLargeRight: () => detailRef.value?.shiftGridLargeRight?.(),
  updateBpmInput: (value: string) => detailRef.value?.updateBpmInput?.(value),
  blurBpmInput: () => detailRef.value?.blurBpmInput?.(),
  tapBpm: () => detailRef.value?.tapBpm?.(),
  toggleMetronome: () => detailRef.value?.toggleMetronome?.(),
  cycleMetronomeVolume: () => detailRef.value?.cycleMetronomeVolume?.()
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
      :playback-rate="props.playbackRate"
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
      :direction="props.direction"
      @toolbar-state-change="emit('toolbar-state-change', $event)"
      @zoom-change="emit('zoom-change', $event)"
      @drag-session-start="emit('drag-session-start')"
      @drag-session-end="emit('drag-session-end', $event)"
    />
  </div>
</template>
