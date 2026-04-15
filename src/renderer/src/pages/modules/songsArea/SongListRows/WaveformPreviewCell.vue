<script setup lang="ts">
import HotCueMarkersLayer from '@renderer/components/HotCueMarkersLayer.vue'
import MemoryCueMarkersLayer from '@renderer/components/MemoryCueMarkersLayer.vue'
import type { ISongInfo } from 'src/types/globals'

const props = defineProps<{
  song: ISongInfo
  widthPx: number
  canPreviewWaveform: boolean
  isWaveformPreviewActive: (filePath: string) => boolean
  handleWaveformClick: (song: ISongInfo, event: MouseEvent) => void
  handleWaveformStopClick: (event: MouseEvent) => void
  handleHotCueClick: (song: ISongInfo, sec: number) => void
  setWaveformCanvasRef: (filePath: string, el: HTMLCanvasElement | null) => void
  getWaveformPlaceholderText: (filePath: string) => string
  getWaveformPlaceholderTitle: (filePath: string) => string
  getWaveformPreviewPlayheadStyle: (filePath: string) => Record<string, string | undefined>
}>()

const parseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}
</script>

<template>
  <div
    class="cell-waveform"
    :style="{ width: `var(--songs-col-waveformPreview, ${props.widthPx}px)` }"
    @click="props.canPreviewWaveform && props.handleWaveformClick(props.song, $event)"
  >
    <div class="waveform-preview-stop-slot">
      <button
        v-if="props.isWaveformPreviewActive(props.song.filePath)"
        class="waveform-preview-stop"
        type="button"
        aria-label="Stop preview"
        @click="props.canPreviewWaveform && props.handleWaveformStopClick($event)"
      ></button>
    </div>
    <div class="waveform-preview-shell">
      <canvas
        :ref="
          (el) => props.setWaveformCanvasRef(props.song.filePath, el as HTMLCanvasElement | null)
        "
        class="waveform-preview-canvas"
      ></canvas>
      <MemoryCueMarkersLayer
        :memory-cues="props.song.memoryCues || []"
        :visible-duration-sec="parseDurationToSeconds(props.song.duration)"
        anchor="top"
        size="tiny"
      />
      <HotCueMarkersLayer
        :hot-cues="props.song.hotCues || []"
        :visible-duration-sec="parseDurationToSeconds(props.song.duration)"
        anchor="top"
        size="tiny"
        clickable
        @marker-click="props.handleHotCueClick(props.song, $event.sec)"
      />
      <div
        v-if="props.getWaveformPlaceholderText(props.song.filePath)"
        class="waveform-preview-placeholder"
        :title="props.getWaveformPlaceholderTitle(props.song.filePath)"
      >
        {{ props.getWaveformPlaceholderText(props.song.filePath) }}
      </div>
      <div
        v-if="props.isWaveformPreviewActive(props.song.filePath)"
        class="waveform-preview-playhead"
        :style="props.getWaveformPreviewPlayheadStyle(props.song.filePath)"
      ></div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.cell-waveform {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 12px 0 7px;
  position: relative;
  cursor: default;
  gap: 6px;
}

.waveform-preview-stop-slot {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.waveform-preview-shell {
  position: relative;
  width: 100%;
  height: 18px;
  flex: 1 1 auto;
  min-width: 0;
}

.waveform-preview-canvas {
  width: 100%;
  height: 18px;
  display: block;
  color: var(--text-weak);
  pointer-events: none;
}

.waveform-preview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  color: var(--text-weak);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.waveform-preview-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
}

.waveform-preview-stop {
  width: 16px;
  height: 16px;
  background: var(--accent);
  border: 1px solid var(--border);
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  z-index: 3;
  opacity: 0.95;
  appearance: none;
  outline: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.2),
    inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease,
    opacity 120ms ease;
}

.waveform-preview-stop::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: var(--bg);
}

.waveform-preview-stop:hover {
  opacity: 1;
  transform: scale(1.05);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.28),
    inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

.waveform-preview-stop:active {
  transform: scale(0.98);
}

.waveform-preview-stop:focus-visible {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent),
    0 2px 6px rgba(0, 0, 0, 0.28);
}
</style>
