<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'

interface Props {
  modelValueStart: number
  modelValueEnd: number
  containerWidth: number
  enablePlaybackRange: boolean
  waveformShow: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValueStart', value: number): void
  (e: 'update:modelValueEnd', value: number): void
  (e: 'dragEnd'): void
}>()

const startHandleRef = ref<HTMLDivElement | null>(null)
const endHandleRef = ref<HTMLDivElement | null>(null)

const isDraggingStart = ref(false)
const isDraggingEnd = ref(false)
const dragStartX = ref(0)
const startPercentAtDragStart = ref(0)
const endPercentAtDragStart = ref(0)

const startHandleLeftPercent = computed(() => props.modelValueStart)
const endHandleLeftPercent = computed(() => props.modelValueEnd)

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
  <div
    v-show="waveformShow && enablePlaybackRange"
    ref="startHandleRef"
    class="manual-handle start-handle"
    :class="{ dragging: isDraggingStart }"
    :style="{ left: startHandleLeftPercent + '%' }"
    @mousedown="(event) => handleMouseDown(event, 'start')"
  >
    <span class="handle-line"></span>
  </div>
  <div
    v-show="waveformShow && enablePlaybackRange"
    ref="endHandleRef"
    class="manual-handle end-handle"
    :class="{ dragging: isDraggingEnd }"
    :style="{ left: endHandleLeftPercent + '%' }"
    @mousedown="(event) => handleMouseDown(event, 'end')"
  >
    <span class="handle-line"></span>
  </div>
</template>

<style scoped>
.manual-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14px;
  transform: translateX(-50%);
  cursor: ew-resize;
  z-index: 12;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.35));
  transition: filter 0.15s ease;
}

.handle-line {
  position: absolute;
  left: 50%;
  top: 7px;
  bottom: 7px;
  width: 2px;
  background: currentColor;
  border-radius: 1px;
  opacity: 0.85;
  transform: translateX(-50%);
  pointer-events: none;
}

.manual-handle::before,
.manual-handle::after {
  content: '';
  position: absolute;
  left: 50%;
  width: 8px;
  height: 8px;
  background: currentColor;
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  opacity: 0.92;
  transform: translateX(-50%);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.45),
    0 2px 4px rgba(0, 0, 0, 0.25);
  transition:
    transform 0.15s ease,
    opacity 0.15s ease;
  pointer-events: none;
}

.manual-handle::before {
  top: -1px;
}

.manual-handle::after {
  bottom: -1px;
  transform: translateX(-50%) rotate(180deg);
}

.end-handle {
  color: #6f6bff;
}

.start-handle {
  color: #f5a524;
}

.manual-handle:hover::before,
.manual-handle.dragging::before {
  opacity: 1;
  transform: translateX(-50%) scale(1.05);
}

.manual-handle:hover::after,
.manual-handle.dragging::after {
  opacity: 1;
  transform: translateX(-50%) rotate(180deg) scale(1.05);
}

.manual-handle:hover,
.manual-handle.dragging {
  filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.45));
}
</style>
