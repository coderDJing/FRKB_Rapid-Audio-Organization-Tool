<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import type { PlaybackRangePercentRange } from '@shared/playbackRange'

interface Props {
  modelValueStart: number
  modelValueEnd: number
  containerWidth: number
  enablePlaybackRange: boolean
  waveformShow: boolean
  locked?: boolean
  lockedRanges?: PlaybackRangePercentRange[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValueStart', value: number): void
  (e: 'update:modelValueEnd', value: number): void
  (e: 'dragEnd'): void
}>()

const isDraggingStart = ref(false)
const isDraggingEnd = ref(false)
const dragStartX = ref(0)
const startPercentAtDragStart = ref(0)
const endPercentAtDragStart = ref(0)

const startHandleLeftPercent = computed(() => props.modelValueStart)
const endHandleLeftPercent = computed(() => props.modelValueEnd)
const normalizePercent = (value: unknown) => {
  const percent = Number(value)
  return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0
}
const lockedDisplayRanges = computed(() => {
  if (!props.locked) return []
  return (props.lockedRanges || [])
    .map((range) => {
      const startPercent = normalizePercent(range.startPercent)
      const endPercent = normalizePercent(range.endPercent)
      return {
        startPercent: Math.min(startPercent, endPercent),
        endPercent: Math.max(startPercent, endPercent)
      }
    })
    .filter((range) => range.endPercent > range.startPercent)
})
const useLockedDisplayRanges = computed(() => props.locked && lockedDisplayRanges.value.length > 0)

const handleGlobalMouseMove = (event: MouseEvent) => {
  if ((!isDraggingStart.value && !isDraggingEnd.value) || props.containerWidth <= 0) return
  const currentX = event.clientX
  const deltaX = currentX - dragStartX.value
  const deltaPercent = (deltaX / props.containerWidth) * 100

  if (isDraggingStart.value) {
    let newStartPercent = startPercentAtDragStart.value + deltaPercent
    newStartPercent = Math.max(0, newStartPercent)
    // 确保开始不超过结束 - 1% (或一个很小的间隔)
    newStartPercent = Math.min(props.modelValueEnd - 0.1, newStartPercent)
    emit('update:modelValueStart', newStartPercent)
  } else if (isDraggingEnd.value) {
    let newEndPercent = endPercentAtDragStart.value + deltaPercent
    // 确保结束不小于开始 + 0.1%
    newEndPercent = Math.max(props.modelValueStart + 0.1, newEndPercent)
    newEndPercent = Math.min(100, newEndPercent)
    emit('update:modelValueEnd', newEndPercent)
  }
}

const handleGlobalMouseUp = () => {
  if (isDraggingStart.value || isDraggingEnd.value) {
    isDraggingStart.value = false
    isDraggingEnd.value = false
    window.removeEventListener('mousemove', handleGlobalMouseMove)
    window.removeEventListener('mouseup', handleGlobalMouseUp)
    emit('dragEnd')
  }
}

const handleMouseDown = (event: MouseEvent, handleType: 'start' | 'end') => {
  if (props.locked) return
  event.preventDefault()
  event.stopPropagation()
  if (props.containerWidth <= 0) {
    console.error('[PlaybackHandles] Container width is 0 or less, cannot start drag.')
    return
  }

  dragStartX.value = event.clientX
  startPercentAtDragStart.value = props.modelValueStart
  endPercentAtDragStart.value = props.modelValueEnd

  if (handleType === 'start') {
    isDraggingStart.value = true
  } else {
    isDraggingEnd.value = true
  }

  window.addEventListener('mousemove', handleGlobalMouseMove)
  window.addEventListener('mouseup', handleGlobalMouseUp)
}

onUnmounted(() => {
  window.removeEventListener('mousemove', handleGlobalMouseMove)
  window.removeEventListener('mouseup', handleGlobalMouseUp)
})
</script>

<template>
  <template v-if="useLockedDisplayRanges">
    <template
      v-for="(range, index) in lockedDisplayRanges"
      :key="`${range.startPercent}-${range.endPercent}-${index}`"
    >
      <div
        v-show="waveformShow && enablePlaybackRange"
        class="manual-handle start-handle is-locked"
        :style="{ left: range.startPercent + '%' }"
        aria-disabled="true"
      >
        <span class="handle-line"></span>
      </div>
      <div
        v-show="waveformShow && enablePlaybackRange"
        class="manual-handle end-handle is-locked"
        :style="{ left: range.endPercent + '%' }"
        aria-disabled="true"
      >
        <span class="handle-line"></span>
      </div>
    </template>
  </template>
  <template v-else>
    <div
      v-show="waveformShow && enablePlaybackRange"
      class="manual-handle start-handle"
      :class="{ dragging: isDraggingStart, 'is-locked': locked }"
      :style="{ left: startHandleLeftPercent + '%' }"
      :aria-disabled="locked"
      @mousedown="(event) => handleMouseDown(event, 'start')"
    >
      <span class="handle-line"></span>
    </div>
    <div
      v-show="waveformShow && enablePlaybackRange"
      class="manual-handle end-handle"
      :class="{ dragging: isDraggingEnd, 'is-locked': locked }"
      :style="{ left: endHandleLeftPercent + '%' }"
      :aria-disabled="locked"
      @mousedown="(event) => handleMouseDown(event, 'end')"
    >
      <span class="handle-line"></span>
    </div>
  </template>
</template>

<style scoped>
.manual-handle {
  --range-handle-outline: rgba(0, 0, 0, 0.68);
  position: absolute;
  top: 0;
  bottom: 0;
  width: 20px;
  transform: translateX(-50%);
  cursor: ew-resize;
  z-index: 12;
  transition: opacity 0.15s ease;
}

.handle-line {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 2px;
  background: currentColor;
  border-radius: 0;
  opacity: 1;
  transform: translateX(-50%);
  box-shadow: 0 0 0 1px var(--range-handle-outline);
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    width 0.15s ease;
}

.start-handle {
  color: #ffb020;
}

.end-handle {
  color: #7c7aff;
}

.manual-handle:hover .handle-line,
.manual-handle.dragging .handle-line {
  width: 3px;
  opacity: 1;
}

.manual-handle.is-locked {
  cursor: default;
  pointer-events: none;
}

.manual-handle.is-locked:hover .handle-line {
  width: 2px;
}

:global(.theme-light) .manual-handle {
  --range-handle-outline: rgba(255, 255, 255, 0.82);
}

:global(.theme-dark) .manual-handle {
  --range-handle-outline: rgba(0, 0, 0, 0.78);
}
</style>
