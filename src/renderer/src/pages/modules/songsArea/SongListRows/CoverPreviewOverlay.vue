<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'

const props = defineProps<{
  active: boolean
  top: number
  left: number
  width: number
  size: number
  imageUrl?: string | null
}>()

defineEmits<{
  mousemove: [event: MouseEvent]
  mouseleave: [event: MouseEvent]
  wheel: [event: WheelEvent]
  contextmenu: [event: MouseEvent]
  dblclick: [event: MouseEvent]
}>()

const overlayStyle = computed<CSSProperties>(() => ({
  top: `${props.top}px`,
  left: `${props.left}px`,
  width: `${props.width}px`,
  height: `${props.size}px`
}))
</script>

<template>
  <div
    v-if="active"
    class="cover-preview-overlay"
    :style="overlayStyle"
    @mousemove="$emit('mousemove', $event)"
    @mouseleave="$emit('mouseleave', $event)"
    @wheel="$emit('wheel', $event)"
    @contextmenu.stop.prevent="$emit('contextmenu', $event)"
    @dblclick.stop.prevent="$emit('dblclick', $event)"
  >
    <img v-if="imageUrl" :src="imageUrl" alt="cover preview" decoding="async" />
    <div v-else class="cover-preview-overlay__skeleton"></div>
  </div>
</template>

<style lang="scss" scoped>
.cover-preview-overlay {
  position: fixed;
  background-color: var(--bg-elev);
  box-shadow:
    0 0 0 2px var(--accent),
    0 10px 30px rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  z-index: var(--z-content-overlay);
  overflow: hidden;
}

.cover-preview-overlay img,
.cover-preview-overlay__skeleton {
  width: 100%;
  height: 100%;
}

.cover-preview-overlay img {
  object-fit: cover;
  display: block;
}

.cover-preview-overlay__skeleton {
  background-color: var(--bg-elev);
}
</style>
