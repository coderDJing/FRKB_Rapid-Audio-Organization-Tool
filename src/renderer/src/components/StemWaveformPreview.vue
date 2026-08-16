<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import { pauseOtherAppPlayback } from '@renderer/utils/exclusivePlayback'

const props = defineProps<{
  src: string
  peaks: number[] | null
  loading?: boolean
  stemLabel: string
}>()

const emit = defineEmits<{
  play: []
}>()

const audio = ref<HTMLAudioElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const isPlaying = ref(false)
const playedRatio = ref(0)
let resizeObserver: ResizeObserver | null = null

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const drawWaveform = () => {
  const target = canvas.value
  if (!target) return
  const bounds = target.getBoundingClientRect()
  const width = Math.max(1, Math.floor(bounds.width))
  const height = Math.max(1, Math.floor(bounds.height))
  const pixelRatio = window.devicePixelRatio || 1
  const outputWidth = Math.max(1, Math.floor(width * pixelRatio))
  const outputHeight = Math.max(1, Math.floor(height * pixelRatio))
  if (target.width !== outputWidth || target.height !== outputHeight) {
    target.width = outputWidth
    target.height = outputHeight
  }
  const context = target.getContext('2d')
  if (!context) return
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  const color = getComputedStyle(target.parentElement || target).color
  const centerY = height / 2
  context.fillStyle = color
  context.globalAlpha = 0.3
  context.fillRect(0, Math.floor(centerY), width, 1)

  const source = props.peaks || []
  if (!source.length) return
  context.globalAlpha = 0.82
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor((x / width) * source.length)
    const end = Math.max(start + 1, Math.ceil(((x + 1) / width) * source.length))
    let peak = 0
    for (let index = start; index < end && index < source.length; index += 1) {
      peak = Math.max(peak, Number(source[index]) || 0)
    }
    const amplitude = Math.max(1, Math.pow(clamp(peak, 0, 1), 0.85) * (height * 0.43))
    context.fillRect(x + 0.2, Math.round(centerY - amplitude), 0.8, Math.round(amplitude * 2))
  }
  context.globalAlpha = 1
}

const syncPlayedRatio = () => {
  const element = audio.value
  if (!element || !Number.isFinite(element.duration) || element.duration <= 0) {
    playedRatio.value = 0
    return
  }
  playedRatio.value = clamp(element.currentTime / element.duration, 0, 1)
}

const play = async (fromStart = false) => {
  const element = audio.value
  if (!element) return
  pauseOtherAppPlayback('stem-preview')
  emit('play')
  if (fromStart) {
    element.currentTime = 0
    playedRatio.value = 0
  }
  try {
    await element.play()
  } catch {}
}

const togglePlayback = () => {
  if (!audio.value) return
  if (audio.value.paused) {
    void play(true)
  } else {
    audio.value.pause()
  }
}

const seekAndPlay = (event: MouseEvent) => {
  const element = audio.value
  const target = canvas.value
  if (!element || !target) return
  const bounds = target.getBoundingClientRect()
  const ratio = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1)
  if (Number.isFinite(element.duration) && element.duration > 0) {
    element.currentTime = ratio * element.duration
    syncPlayedRatio()
  }
  void play()
}

const handlePlay = () => {
  isPlaying.value = true
}

const handlePause = () => {
  isPlaying.value = false
  syncPlayedRatio()
}

const handleEnded = () => {
  isPlaying.value = false
  if (audio.value) audio.value.currentTime = 0
  playedRatio.value = 0
}

const pause = () => audio.value?.pause()

watch(
  () => [props.peaks, props.loading],
  () => void nextTick(drawWaveform),
  { deep: true }
)

watch(
  () => props.src,
  () => {
    audio.value?.pause()
    if (audio.value) audio.value.currentTime = 0
    isPlaying.value = false
    playedRatio.value = 0
    void nextTick(drawWaveform)
  }
)

defineExpose({ pause })

onUnmounted(() => {
  resizeObserver?.disconnect()
  audio.value?.pause()
  if (audio.value) audio.value.src = ''
})

const bindCanvas = (element: HTMLCanvasElement | null) => {
  canvas.value = element
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!element || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => drawWaveform())
  resizeObserver.observe(element)
  void nextTick(drawWaveform)
}
</script>

<template>
  <div
    class="stem-waveform-preview"
    :class="{ 'is-loading': props.loading, 'is-playing': isPlaying }"
  >
    <audio
      ref="audio"
      class="stem-waveform-preview__audio"
      preload="metadata"
      :src="props.src"
      @play="handlePlay"
      @pause="handlePause"
      @ended="handleEnded"
      @loadedmetadata="syncPlayedRatio"
      @timeupdate="syncPlayedRatio"
    />
    <bubbleBoxTrigger
      tag="button"
      class="stem-waveform-preview__toggle"
      type="button"
      :title="isPlaying ? t('stemSeparation.pausePreview') : t('stemSeparation.playPreview')"
      :aria-label="
        isPlaying
          ? t('stemSeparation.pausePreviewForStem', { stem: props.stemLabel })
          : t('stemSeparation.playPreviewForStem', { stem: props.stemLabel })
      "
      @click="togglePlayback"
    >
      <span aria-hidden="true" />
    </bubbleBoxTrigger>
    <bubbleBoxTrigger
      tag="button"
      class="stem-waveform-preview__waveform"
      type="button"
      :title="t('stemSeparation.seekPreview')"
      :aria-label="t('stemSeparation.seekPreviewForStem', { stem: props.stemLabel })"
      @click="seekAndPlay"
    >
      <canvas :ref="bindCanvas" class="stem-waveform-preview__canvas" />
      <span
        v-if="isPlaying"
        class="stem-waveform-preview__playhead"
        :style="{ left: `${playedRatio * 100}%` }"
      />
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.stem-waveform-preview {
  display: flex;
  height: 36px;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.stem-waveform-preview__audio {
  display: none;
}

.stem-waveform-preview__toggle,
.stem-waveform-preview__waveform {
  box-sizing: border-box;
  border: 0;
  appearance: none;
  cursor: pointer;
  font: inherit;
}

.stem-waveform-preview__toggle {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  transition:
    transform 160ms ease,
    box-shadow 160ms ease,
    filter 160ms ease;
}

.stem-waveform-preview__toggle span {
  display: block;
  width: 0;
  height: 0;
  margin-left: 2px;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 7px solid #ffffff;
}

.stem-waveform-preview__toggle:focus-visible,
.stem-waveform-preview__waveform:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
  outline-offset: 2px;
}

.stem-waveform-preview__toggle:hover {
  filter: brightness(1.08);
  box-shadow: 0 4px 10px color-mix(in srgb, var(--accent) 32%, transparent);
  transform: translateY(-1px) scale(1.04);
}

.stem-waveform-preview__waveform {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 36px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--waveform-bg);
  color: var(--accent);
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.stem-waveform-preview__waveform:hover {
  border-color: var(--accent);
  box-shadow: 0 3px 12px color-mix(in srgb, var(--accent) 14%, transparent);
}

.stem-waveform-preview__canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.stem-waveform-preview__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--text);
  pointer-events: none;
  transform: translateX(-50%);
}

.stem-waveform-preview.is-playing .stem-waveform-preview__toggle span {
  width: 8px;
  height: 10px;
  margin-left: 0;
  border: 0;
  background: linear-gradient(90deg, #ffffff 0 38%, transparent 38% 62%, #ffffff 62% 100%);
}

.stem-waveform-preview.is-playing .stem-waveform-preview__waveform {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--border));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent);
}
.stem-waveform-preview.is-loading .stem-waveform-preview__waveform {
  animation: stem-waveform-preview-loading 1.8s ease-in-out infinite;
}
@keyframes stem-waveform-preview-loading {
  50% {
    border-color: color-mix(in srgb, var(--accent) 56%, var(--border));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 9%, transparent);
    opacity: 0.82;
  }
}
@media (prefers-reduced-motion: reduce) {
  .stem-waveform-preview__toggle,
  .stem-waveform-preview__waveform {
    transition: none;
  }
  .stem-waveform-preview.is-loading .stem-waveform-preview__waveform {
    animation: none;
  }
}
</style>
