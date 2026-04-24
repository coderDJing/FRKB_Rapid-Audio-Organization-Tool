<script setup lang="ts">
import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import type { ISongMemoryCue } from 'src/types/globals'
import {
  formatSongMemoryCueTime,
  normalizeSongMemoryCues,
  resolveSongMemoryCueDisplayColor
} from '@shared/memoryCues'

const props = defineProps<{
  memoryCues?: ISongMemoryCue[] | null
  startSec?: number
  visibleDurationSec: number
  showLoopRange?: boolean
  anchor?: 'top' | 'bottom'
  offsetPx?: number
  size?: 'default' | 'compact' | 'tiny'
}>()

const buildLoopStyle = (
  rangeStartSec: number,
  cueStartSec: number,
  cueEndSec: number,
  visibleDurationSec: number
) => {
  const rangeEndSec = rangeStartSec + visibleDurationSec
  const loopVisibleStartSec = Math.max(rangeStartSec, cueStartSec)
  const loopVisibleEndSec = Math.min(rangeEndSec, cueEndSec)
  if (loopVisibleEndSec <= loopVisibleStartSec) return null
  const left = ((loopVisibleStartSec - rangeStartSec) / visibleDurationSec) * 100
  const width = ((loopVisibleEndSec - loopVisibleStartSec) / visibleDurationSec) * 100
  return {
    left: `${left}%`,
    width: `${width}%`
  }
}

const visibleMarkers = computed(() => {
  const startSec = Number(props.startSec) || 0
  const visibleDurationSec = Number(props.visibleDurationSec)
  if (!Number.isFinite(visibleDurationSec) || visibleDurationSec <= 0) return []
  const rangeEndSec = startSec + visibleDurationSec
  return normalizeSongMemoryCues(props.memoryCues)
    .filter((item) => {
      const loopEndSec = Number(item.loopEndSec)
      const hasVisibleLoop =
        Boolean(item.isLoop) &&
        Number.isFinite(loopEndSec) &&
        loopEndSec > item.sec &&
        loopEndSec >= startSec &&
        item.sec <= rangeEndSec
      return (item.sec >= startSec && item.sec <= rangeEndSec) || hasVisibleLoop
    })
    .map((item) => {
      const loopEndSec = Number(item.loopEndSec)
      const isLoop =
        Boolean(item.isLoop) && Number.isFinite(loopEndSec) && loopEndSec > item.sec + 0.0001
      const titleParts = ['Memory Cue', formatSongMemoryCueTime(item.sec)]
      if (isLoop) {
        titleParts.push(`Loop ${formatSongMemoryCueTime(loopEndSec)}`)
      }
      if (item.comment) {
        titleParts.push(item.comment)
      }
      return {
        ...item,
        left: `${((item.sec - startSec) / visibleDurationSec) * 100}%`,
        color: resolveSongMemoryCueDisplayColor(item),
        title: titleParts.join(' · '),
        loopStyle:
          props.showLoopRange && isLoop
            ? buildLoopStyle(startSec, item.sec, loopEndSec, visibleDurationSec)
            : null
      }
    })
})
</script>

<template>
  <template
    v-for="marker in visibleMarkers"
    :key="`${marker.order || 0}-${marker.sec}-${marker.loopEndSec || 0}`"
  >
    <div
      v-if="marker.loopStyle"
      class="memorycue-marker__loop"
      :class="[
        props.anchor === 'bottom'
          ? 'memorycue-marker__loop--bottom'
          : 'memorycue-marker__loop--top',
        props.size === 'tiny' ? 'is-tiny' : props.size === 'compact' ? 'is-compact' : ''
      ]"
      :style="{
        ...marker.loopStyle,
        '--memorycue-marker-color': marker.color,
        '--memorycue-marker-offset': `${Number(props.offsetPx) || 0}px`
      }"
    ></div>
    <bubbleBoxTrigger
      tag="div"
      class="memorycue-marker"
      :class="[
        props.anchor === 'bottom' ? 'memorycue-marker--bottom' : 'memorycue-marker--top',
        props.size === 'tiny' ? 'is-tiny' : props.size === 'compact' ? 'is-compact' : '',
        marker.source === 'rekordbox' ? 'is-rekordbox' : ''
      ]"
      :style="{
        left: marker.left,
        '--memorycue-marker-color': marker.color,
        '--memorycue-marker-offset': `${Number(props.offsetPx) || 0}px`
      }"
      :title="marker.title"
    />
  </template>
</template>

<style scoped lang="scss">
.memorycue-marker {
  position: absolute;
  width: 10px;
  height: 7px;
  transform: translateX(-50%);
  background: var(--memorycue-marker-color, #df4d4d);
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

.memorycue-marker__loop {
  position: absolute;
  height: 3px;
  background: color-mix(in srgb, var(--memorycue-marker-color, #df4d4d) 26%, transparent);
  box-shadow: inset 0 0 0 1px
    color-mix(in srgb, var(--memorycue-marker-color, #df4d4d) 44%, transparent);
  pointer-events: none;
  z-index: 2;
}

.memorycue-marker__loop--top {
  top: calc(var(--memorycue-marker-offset, 0px) + 8px);
}

.memorycue-marker__loop--bottom {
  bottom: calc(var(--memorycue-marker-offset, 0px) + 8px);
}

.memorycue-marker__loop.is-compact {
  height: 2px;
}

.memorycue-marker__loop.is-compact.memorycue-marker__loop--top {
  top: calc(var(--memorycue-marker-offset, 0px) + 7px);
}

.memorycue-marker__loop.is-compact.memorycue-marker__loop--bottom {
  bottom: calc(var(--memorycue-marker-offset, 0px) + 7px);
}

.memorycue-marker__loop.is-tiny {
  height: 2px;
}

.memorycue-marker__loop.is-tiny.memorycue-marker__loop--top {
  top: calc(var(--memorycue-marker-offset, 0px) + 5px);
}

.memorycue-marker__loop.is-tiny.memorycue-marker__loop--bottom {
  bottom: calc(var(--memorycue-marker-offset, 0px) + 5px);
}

.memorycue-marker.is-rekordbox {
  filter: saturate(1.06);
}
</style>
