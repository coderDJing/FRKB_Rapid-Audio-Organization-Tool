<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'

const props = defineProps<{
  progress: number | null
  viewportWidth: number
  scrollLeft: number
}>()

const safeProgress = computed(() => {
  if (props.progress == null) return null
  return Math.min(100, Math.max(0, Math.round(props.progress)))
})

const barStyle = computed<CSSProperties>(() => {
  const progress = safeProgress.value ?? 0
  const viewportWidth = Math.max(0, Math.floor(props.viewportWidth || 0))
  const scrollLeft = Math.max(0, Math.round(props.scrollLeft || 0))
  const width = progress === 0 ? viewportWidth : Math.round((viewportWidth * progress) / 100)

  return {
    width: `${width}px`,
    transform: `translateX(${scrollLeft}px)`
  }
})
</script>

<template>
  <div
    v-if="safeProgress != null && viewportWidth > 0"
    class="row-analysis-bar"
    :class="{
      'row-analysis-bar--waiting': safeProgress === 0,
      'row-analysis-bar--active': safeProgress > 0
    }"
    :style="barStyle"
  ></div>
</template>

<style lang="scss" scoped>
.row-analysis-bar {
  position: absolute;
  left: 0;
  bottom: 1px;
  height: 2px;
  border-radius: 1px;
  pointer-events: none;
  z-index: 1;
  transition: width 0.3s ease;
  will-change: transform, width;
}

.row-analysis-bar--waiting {
  background: var(--text-weak);
  opacity: 0.2;
}

.row-analysis-bar--active {
  background: var(--accent, #5b8def);
  opacity: 0.7;
}
</style>
