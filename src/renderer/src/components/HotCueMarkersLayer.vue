<script setup lang="ts">
import { computed } from 'vue'
import type { ISongHotCue } from 'src/types/globals'
import {
  formatSongHotCueTime,
  normalizeSongHotCues,
  resolveSongHotCueColor,
  resolveSongHotCueLabel
} from '@shared/hotCues'

const props = defineProps<{
  hotCues?: ISongHotCue[] | null
  startSec?: number
  visibleDurationSec: number
  anchor?: 'top' | 'bottom'
  size?: 'default' | 'compact' | 'tiny'
  offsetPx?: number
  clickable?: boolean
}>()

const emit = defineEmits<{
  (event: 'marker-click', payload: { slot: number; sec: number }): void
}>()

const visibleMarkers = computed(() => {
  const startSec = Number(props.startSec) || 0
  const visibleDurationSec = Number(props.visibleDurationSec)
  if (!Number.isFinite(visibleDurationSec) || visibleDurationSec <= 0) return []
  return normalizeSongHotCues(props.hotCues)
    .filter((item) => item.sec >= startSec && item.sec <= startSec + visibleDurationSec)
    .map((item) => ({
      ...item,
      left: `${((item.sec - startSec) / visibleDurationSec) * 100}%`,
      label: resolveSongHotCueLabel(item.slot),
      color: resolveSongHotCueColor(item.slot),
      title: `Hot Cue ${resolveSongHotCueLabel(item.slot)} · ${formatSongHotCueTime(item.sec)}`
    }))
})
</script>

<template>
  <div
    v-for="marker in visibleMarkers"
    :key="`${marker.slot}-${marker.sec}`"
    class="hotcue-marker"
    :class="[
      props.anchor === 'bottom' ? 'hotcue-marker--bottom' : 'hotcue-marker--top',
      props.size === 'tiny' ? 'is-tiny' : props.size === 'compact' ? 'is-compact' : ''
    ]"
    :style="{
      left: marker.left,
      '--hotcue-marker-color': marker.color,
      '--hotcue-marker-offset': `${Number(props.offsetPx) || 0}px`
    }"
    :title="marker.title"
  >
    <component
      :is="props.clickable ? 'button' : 'span'"
      class="hotcue-marker__label"
      :class="{ 'is-clickable': props.clickable }"
      :type="props.clickable ? 'button' : undefined"
      @pointerdown.stop
      @click.stop="props.clickable && emit('marker-click', { slot: marker.slot, sec: marker.sec })"
    >
      {{ marker.label }}
    </component>
  </div>
</template>

<style scoped lang="scss">
.hotcue-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 4;
}

.hotcue-marker__label {
  position: absolute;
  left: 50%;
  min-width: 18px;
  height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hotcue-marker-color, var(--accent)) 88%, #121212 12%);
  color: #ffffff;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  transform: translateX(-50%);
  box-sizing: border-box;
  border: 0;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--hotcue-marker-color, var(--accent)) 32%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.24);
  appearance: none;
  pointer-events: none;
}

.hotcue-marker__label.is-clickable {
  cursor: pointer;
  pointer-events: auto;
}

.hotcue-marker--top .hotcue-marker__label {
  top: var(--hotcue-marker-offset, 0px);
}

.hotcue-marker--bottom .hotcue-marker__label {
  bottom: var(--hotcue-marker-offset, 0px);
}

.hotcue-marker.is-compact .hotcue-marker__label {
  min-width: 15px;
  height: 12px;
  padding: 0 3px;
  font-size: 8px;
  line-height: 12px;
}

.hotcue-marker.is-tiny .hotcue-marker__label {
  min-width: 11px;
  height: 9px;
  padding: 0 2px;
  font-size: 6px;
  line-height: 9px;
  border-radius: 2px;
}
</style>
