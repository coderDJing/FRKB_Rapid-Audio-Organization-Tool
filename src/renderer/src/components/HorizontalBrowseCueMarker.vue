<script setup lang="ts">
import { computed } from 'vue'
import { resolveHorizontalBrowseTimePercent } from '@renderer/components/horizontalBrowseDetailMath'

const props = defineProps<{
  cueSeconds?: number
  previewStartSec: number
  visibleDurationSec: number
  direction: 'up' | 'down'
}>()

const cueMarkerLeft = computed(() => {
  const ratio = resolveHorizontalBrowseTimePercent(
    Number(props.cueSeconds),
    props.previewStartSec,
    props.visibleDurationSec
  )
  return ratio === null ? null : `${ratio * 100}%`
})
</script>

<template>
  <div
    v-if="cueMarkerLeft !== null"
    class="raw-detail-waveform__cue-marker"
    :class="`raw-detail-waveform__cue-marker--${props.direction}`"
    :style="{ left: cueMarkerLeft }"
  ></div>
</template>

<style scoped lang="scss">
.raw-detail-waveform__cue-marker {
  position: absolute;
  width: 10px;
  height: 7px;
  transform: translateX(-50%);
  background: var(--shell-cue-accent, #d98921);
  pointer-events: none;
  z-index: 3;
}

.raw-detail-waveform__cue-marker--up {
  top: -8px;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}

.raw-detail-waveform__cue-marker--down {
  bottom: -8px;
  clip-path: polygon(50% 0, 0 100%, 100% 100%);
}
</style>
