<script setup lang="ts">
import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import type { ISongHotCue } from 'src/types/globals'
import {
  formatSongHotCueTime,
  normalizeSongHotCues,
  resolveSongHotCueDisplayColor,
  resolveSongHotCueDisplayLabel
} from '@shared/hotCues'

const props = defineProps<{
  hotCues?: ISongHotCue[] | null
  startSec?: number
  visibleDurationSec: number
  showLoopRange?: boolean
  anchor?: 'top' | 'bottom'
  size?: 'default' | 'compact' | 'tiny'
  offsetPx?: number
  clickable?: boolean
}>()

const emit = defineEmits<{
  (event: 'marker-click', payload: { slot: number; sec: number }): void
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
  return normalizeSongHotCues(props.hotCues)
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
      const label = resolveSongHotCueDisplayLabel(item)
      const color = resolveSongHotCueDisplayColor(item)
      const titleParts = [`Hot Cue ${label}`, formatSongHotCueTime(item.sec)]
      if (isLoop) {
        titleParts.push(`Loop ${formatSongHotCueTime(loopEndSec)}`)
      }
      if (item.comment) {
        titleParts.push(item.comment)
      }
      return {
        ...item,
        left: `${((item.sec - startSec) / visibleDurationSec) * 100}%`,
        label,
        color,
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
  <template v-for="marker in visibleMarkers" :key="`${marker.slot}-${marker.sec}`">
    <div
      v-if="marker.loopStyle"
      class="hotcue-marker__loop"
      :class="[
        props.anchor === 'bottom' ? 'hotcue-marker__loop--bottom' : 'hotcue-marker__loop--top',
        props.size === 'tiny' ? 'is-tiny' : props.size === 'compact' ? 'is-compact' : '',
        marker.source === 'rekordbox' ? 'is-rekordbox' : ''
      ]"
      :style="{
        ...marker.loopStyle,
        '--hotcue-marker-color': marker.color,
        '--hotcue-marker-offset': `${Number(props.offsetPx) || 0}px`
      }"
    ></div>
    <bubbleBoxTrigger
      tag="div"
      class="hotcue-marker"
      :class="[
        props.anchor === 'bottom' ? 'hotcue-marker--bottom' : 'hotcue-marker--top',
        props.size === 'tiny' ? 'is-tiny' : props.size === 'compact' ? 'is-compact' : '',
        marker.source === 'rekordbox' ? 'is-rekordbox' : ''
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
        :class="{ 'is-clickable': props.clickable, 'is-loop': marker.isLoop }"
        :type="props.clickable ? 'button' : undefined"
        @pointerdown.stop
        @click.stop="
          props.clickable && emit('marker-click', { slot: marker.slot, sec: marker.sec })
        "
      >
        {{ marker.label }}
      </component>
    </bubbleBoxTrigger>
  </template>
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

.hotcue-marker.is-rekordbox .hotcue-marker__label {
  border-radius: 2px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--hotcue-marker-color, var(--accent)) 42%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.34);
}

.hotcue-marker__label.is-clickable {
  cursor: pointer;
  pointer-events: auto;
}

.hotcue-marker__label.is-loop {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--hotcue-marker-color, var(--accent)) 52%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.24),
    inset 0 -1px 0 rgba(255, 255, 255, 0.22);
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

.hotcue-marker__loop {
  position: absolute;
  height: 4px;
  transform: translateY(0);
  background: color-mix(in srgb, var(--hotcue-marker-color, var(--accent)) 26%, transparent);
  box-shadow: inset 0 0 0 1px
    color-mix(in srgb, var(--hotcue-marker-color, var(--accent)) 48%, transparent);
  pointer-events: none;
  z-index: 3;
}

.hotcue-marker__loop--top {
  top: calc(var(--hotcue-marker-offset, 0px) + 15px);
}

.hotcue-marker__loop--bottom {
  bottom: calc(var(--hotcue-marker-offset, 0px) + 15px);
}

.hotcue-marker__loop.is-compact {
  height: 3px;
}

.hotcue-marker__loop.is-compact.hotcue-marker__loop--top {
  top: calc(var(--hotcue-marker-offset, 0px) + 13px);
}

.hotcue-marker__loop.is-compact.hotcue-marker__loop--bottom {
  bottom: calc(var(--hotcue-marker-offset, 0px) + 13px);
}

.hotcue-marker__loop.is-tiny {
  height: 2px;
}

.hotcue-marker__loop.is-tiny.hotcue-marker__loop--top {
  top: calc(var(--hotcue-marker-offset, 0px) + 10px);
}

.hotcue-marker__loop.is-tiny.hotcue-marker__loop--bottom {
  bottom: calc(var(--hotcue-marker-offset, 0px) + 10px);
}

.hotcue-marker__loop.is-rekordbox {
  border-radius: 1px;
}
</style>
