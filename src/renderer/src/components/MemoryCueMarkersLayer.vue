<script setup lang="ts">
import { computed } from 'vue'
import type { ISongMemoryCue } from 'src/types/globals'
import { normalizeSongMemoryCues } from '@shared/memoryCues'

const props = defineProps<{
  memoryCues?: ISongMemoryCue[] | null
  startSec?: number
  visibleDurationSec: number
  anchor?: 'top' | 'bottom'
  offsetPx?: number
  size?: 'default' | 'compact' | 'tiny'
}>()

const visibleMarkers = computed(() => {
  const startSec = Number(props.startSec) || 0
  const visibleDurationSec = Number(props.visibleDurationSec)
  if (!Number.isFinite(visibleDurationSec) || visibleDurationSec <= 0) return []
  return normalizeSongMemoryCues(props.memoryCues)
    .filter((item) => item.sec >= startSec && item.sec <= startSec + visibleDurationSec)
    .map((item) => ({
      ...item,
      left: `${((item.sec - startSec) / visibleDurationSec) * 100}%`
    }))
})
</script>

<template>
  <div
    v-for="marker in visibleMarkers"
    :key="marker.sec"
    class="memorycue-marker"
    :class="[
      props.anchor === 'bottom' ? 'memorycue-marker--bottom' : 'memorycue-marker--top',
      props.size === 'tiny' ? 'is-tiny' : props.size === 'compact' ? 'is-compact' : ''
    ]"
    :style="{ left: marker.left, '--memorycue-marker-offset': `${Number(props.offsetPx) || 0}px` }"
    :title="`Memory Cue · ${marker.sec.toFixed(3)}s`"
  ></div>
</template>

<style scoped lang="scss">
.memorycue-marker {
  position: absolute;
  width: 10px;
  height: 7px;
  transform: translateX(-50%);
  background: #df4d4d;
  pointer-events: none;
  z-index: 3;
}

.memorycue-marker--top {
  top: var(--memorycue-marker-offset, 0px);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}

.memorycue-marker--bottom {
  bottom: var(--memorycue-marker-offset, 0px);
  clip-path: polygon(50% 0, 0 100%, 100% 100%);
}

.memorycue-marker.is-compact {
  width: 8px;
  height: 6px;
}

.memorycue-marker.is-tiny {
  width: 6px;
  height: 4px;
}
</style>
