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
    class="manual-handle start-handle"
    ref="startHandleRef"
    :style="{ left: startHandleLeftPercent + '%' }"
    @mousedown="(event) => handleMouseDown(event, 'start')"
  ></div>
  <div
    v-show="waveformShow && enablePlaybackRange"
    class="manual-handle end-handle"
    ref="endHandleRef"
    :style="{ left: endHandleLeftPercent + '%' }"
    @mousedown="(event) => handleMouseDown(event, 'end')"
  ></div>
</template>

<style scoped>
.manual-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  cursor: default;
  z-index: 12;
}

.manual-handle::before,
.manual-handle::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  background-color: currentColor;
  cursor: ew-resize;
  opacity: 0.9;
}

.manual-handle::before {
  top: 0;
  transform: translateX(-50%);
}

.manual-handle::after {
  bottom: 0;
  transform: translateX(-50%);
}

.start-handle {
  color: #2ecc71;
  background-color: #2ecc71;
}

.start-handle::before,
.start-handle::after {
  left: 50%;
}

.end-handle {
  color: #e74c3c;
  background-color: #e74c3c;
}

.end-handle::before,
.end-handle::after {
  left: 50%;
}

.manual-handle:hover::before,
.manual-handle:hover::after,
.manual-handle.dragging::before,
.manual-handle.dragging::after {
  opacity: 1;
}
</style>
