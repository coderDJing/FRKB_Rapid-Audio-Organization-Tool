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
  background: transparent;
  pointer-events: none;
  z-index: 3;
}

.raw-detail-waveform__cue-marker::before,
.raw-detail-waveform__cue-marker::after {
  content: '';
  position: absolute;
  inset: 0;
}

.raw-detail-waveform__cue-marker::before {
  background: rgba(0, 0, 0, 0.88);
}

.raw-detail-waveform__cue-marker::after {
  inset: 1px;
  background: var(--shell-cue-accent, #d98921);
}

.raw-detail-waveform__cue-marker--up {
  bottom: 0;
}

.raw-detail-waveform__cue-marker--up::before,
.raw-detail-waveform__cue-marker--up::after {
  clip-path: polygon(50% 0, 0 100%, 100% 100%);
}

.raw-detail-waveform__cue-marker--down {
  top: 0;
}

.raw-detail-waveform__cue-marker--down::before,
.raw-detail-waveform__cue-marker--down::after {
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
</style>
