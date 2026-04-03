<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import type { IPioneerPreviewWaveformData, ISongInfo } from 'src/types/globals'
import type {
  MixxxWaveformData,
  RGBWaveformBandKey,
  WaveformStyle
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'

const props = defineProps<{
  song: ISongInfo | null
  currentSeconds?: number
  durationSeconds?: number
}>()

const emit = defineEmits<{
  (event: 'seek', value: number): void
}>()

type MinMaxSample = {
  min: number
  max: number
}

type MixxxColumnMetrics = {
  amplitudeLeft: number
  amplitudeRight: number
  color: { r: number; g: number; b: number }
}

type WaveformBatchResponse = {
  items?: Array<{ filePath: string; data: MixxxWaveformData | null }>
}

type PioneerPreviewWaveformResponse = {
  items?: Array<{ analyzePath: string; data: IPioneerPreviewWaveformData | null }>
}

type WaveformCacheChannel = 'waveform-cache:batch' | 'mixtape-waveform-cache:batch'

const runtime = useRuntimeStore()
const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const waveformData = ref<MixxxWaveformData | null>(null)
const pioneerPreviewData = ref<IPioneerPreviewWaveformData | null>(null)
const scrubbing = ref(false)

const WAVEFORM_STYLE_SOUND_CLOUD: WaveformStyle = 'SoundCloud'
const WAVEFORM_STYLE_FINE: WaveformStyle = 'Fine'
const WAVEFORM_STYLE_RGB: WaveformStyle = 'RGB'
const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const MIXXX_RGB_COMPONENTS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
let seekRaf = 0
let pendingSeekSeconds: number | null = null

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

const totalSeconds = computed(() => {
  const explicit = Number(props.durationSeconds)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return parseDurationToSeconds(props.song?.duration)
})

const playheadLeft = computed(() => {
  if (!props.song || totalSeconds.value <= 0) return null
  const current = Number(props.currentSeconds)
  const ratio = Number.isFinite(current)
    ? Math.max(0, Math.min(1, current / totalSeconds.value))
    : 0
  return `${ratio * 100}%`
})

const flushPendingSeek = () => {
  seekRaf = 0
  if (pendingSeekSeconds === null) return
  emit('seek', pendingSeekSeconds)
}

const scheduleSeek = (seconds: number, immediate = false) => {
  pendingSeekSeconds = seconds
  if (immediate) {
    if (seekRaf) {
      cancelAnimationFrame(seekRaf)
      seekRaf = 0
    }
    flushPendingSeek()
    return
  }
  if (seekRaf) return
  seekRaf = requestAnimationFrame(flushPendingSeek)
}

const resolveSeekSecondsByClientX = (clientX: number) => {
  const container = containerRef.value
  if (!container || totalSeconds.value <= 0) return null
  const rect = container.getBoundingClientRect()
  if (rect.width <= 0) return null
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return ratio * totalSeconds.value
}

const handlePointerMove = (event: PointerEvent) => {
  if (!scrubbing.value) return
  const seconds = resolveSeekSecondsByClientX(event.clientX)
  if (seconds === null) return
  scheduleSeek(seconds)
}

const stopScrubbing = () => {
  if (!scrubbing.value) return
  scrubbing.value = false
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerUp)
}

const handlePointerUp = (event: PointerEvent) => {
  const seconds = resolveSeekSecondsByClientX(event.clientX)
  if (seconds !== null) scheduleSeek(seconds, true)
  stopScrubbing()
}

const handlePointerDown = (event: PointerEvent) => {
  if (event.button !== 0 || !props.song || totalSeconds.value <= 0) return
  const seconds = resolveSeekSecondsByClientX(event.clientX)
  if (seconds === null) return
  scrubbing.value = true
  scheduleSeek(seconds, true)
  window.addEventListener('pointermove', handlePointerMove, { passive: true })
  window.addEventListener('pointerup', handlePointerUp, { passive: true })
  window.addEventListener('pointercancel', handlePointerUp, { passive: true })
  event.preventDefault()
}

const normalizeWaveformStyle = (
  style?: WaveformStyle | 'RekordboxMini' | 'Mixxx'
): WaveformStyle => {
  if (style === 'RekordboxMini' || style === 'Mixxx') return WAVEFORM_STYLE_RGB
  if (
    style === WAVEFORM_STYLE_SOUND_CLOUD ||
    style === WAVEFORM_STYLE_FINE ||
    style === WAVEFORM_STYLE_RGB
  ) {
    return style
  }
  return WAVEFORM_STYLE_SOUND_CLOUD
}

const getWaveformStyle = () => normalizeWaveformStyle(runtime.setting?.waveformStyle)

const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'

const resizeCanvas = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) => {
  const pixelRatio = window.devicePixelRatio || 1
  const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
  const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))

  if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
    canvas.width = scaledWidth
    canvas.height = scaledHeight
  }

  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(pixelRatio, pixelRatio)
}

const clearCanvas = () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const buildMinMaxDataFromMixxx = (data: MixxxWaveformData): MinMaxSample[] => {
  const low = data.bands.low
  const mid = data.bands.mid
  const high = data.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (!frameCount) return []

  const result = new Array<MinMaxSample>(frameCount)
  for (let index = 0; index < frameCount; index++) {
    const lowLeft = low.peakLeft ? low.peakLeft[index] : low.left[index]
    const lowRight = low.peakRight ? low.peakRight[index] : low.right[index]
    const midLeft = mid.peakLeft ? mid.peakLeft[index] : mid.left[index]
    const midRight = mid.peakRight ? mid.peakRight[index] : mid.right[index]
    const highLeft = high.peakLeft ? high.peakLeft[index] : high.left[index]
    const highRight = high.peakRight ? high.peakRight[index] : high.right[index]

    const leftEnergy = Math.sqrt(lowLeft * lowLeft + midLeft * midLeft + highLeft * highLeft)
    const rightEnergy = Math.sqrt(lowRight * lowRight + midRight * midRight + highRight * highRight)

    result[index] = {
      min: -Math.min(1, rightEnergy / MIXXX_MAX_RGB_ENERGY),
      max: Math.min(1, leftEnergy / MIXXX_MAX_RGB_ENERGY)
    }
  }

  return result
}

const computeMixxxColumnMetrics = (
  columnCount: number,
  data: MixxxWaveformData | null
): MixxxColumnMetrics[] => {
  if (!data || columnCount <= 0) return []

  const low = data.bands.low
  const mid = data.bands.mid
  const high = data.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (!frameCount) return []

  const columns = new Array<MixxxColumnMetrics>(columnCount)
  const dataSize = frameCount * 2
  const gain = dataSize / Math.max(1, columnCount)
  const lastVisualFrame = frameCount - 1

  for (let x = 0; x < columnCount; x++) {
    const xSampleWidth = gain * x
    const maxSamplingRange = gain / 2
    let visualFrameStart = Math.floor(xSampleWidth / 2 - maxSamplingRange + 0.5)
    let visualFrameStop = Math.floor(xSampleWidth / 2 + maxSamplingRange + 0.5)

    if (visualFrameStart < 0) visualFrameStart = 0
    if (visualFrameStop > lastVisualFrame) visualFrameStop = lastVisualFrame
    if (visualFrameStop < visualFrameStart) visualFrameStop = visualFrameStart

    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllLeft = 0
    let maxAllRight = 0

    for (let index = visualFrameStart; index <= visualFrameStop; index++) {
      const lowLeft = low.left[index]
      const lowRight = low.right[index]
      const midLeft = mid.left[index]
      const midRight = mid.right[index]
      const highLeft = high.left[index]
      const highRight = high.right[index]
      const lowLeftAmp = low.peakLeft ? low.peakLeft[index] : lowLeft
      const lowRightAmp = low.peakRight ? low.peakRight[index] : lowRight
      const midLeftAmp = mid.peakLeft ? mid.peakLeft[index] : midLeft
      const midRightAmp = mid.peakRight ? mid.peakRight[index] : midRight
      const highLeftAmp = high.peakLeft ? high.peakLeft[index] : highLeft
      const highRightAmp = high.peakRight ? high.peakRight[index] : highRight

      if (lowLeft > maxLow) maxLow = lowLeft
      if (lowRight > maxLow) maxLow = lowRight
      if (midLeft > maxMid) maxMid = midLeft
      if (midRight > maxMid) maxMid = midRight
      if (highLeft > maxHigh) maxHigh = highLeft
      if (highRight > maxHigh) maxHigh = highRight

      const allLeft = lowLeftAmp * lowLeftAmp + midLeftAmp * midLeftAmp + highLeftAmp * highLeftAmp
      const allRight =
        lowRightAmp * lowRightAmp + midRightAmp * midRightAmp + highRightAmp * highRightAmp

      if (allLeft > maxAllLeft) maxAllLeft = allLeft
      if (allRight > maxAllRight) maxAllRight = allRight
    }

    const red =
      maxLow * MIXXX_RGB_COMPONENTS.low.r +
      maxMid * MIXXX_RGB_COMPONENTS.mid.r +
      maxHigh * MIXXX_RGB_COMPONENTS.high.r
    const green =
      maxLow * MIXXX_RGB_COMPONENTS.low.g +
      maxMid * MIXXX_RGB_COMPONENTS.mid.g +
      maxHigh * MIXXX_RGB_COMPONENTS.high.g
    const blue =
      maxLow * MIXXX_RGB_COMPONENTS.low.b +
      maxMid * MIXXX_RGB_COMPONENTS.mid.b +
      maxHigh * MIXXX_RGB_COMPONENTS.high.b

    const maxColor = Math.max(red, green, blue)
    columns[x] = {
      amplitudeLeft: Math.min(1, Math.sqrt(maxAllLeft) / MIXXX_MAX_RGB_ENERGY),
      amplitudeRight: Math.min(1, Math.sqrt(maxAllRight) / MIXXX_MAX_RGB_ENERGY),
      color:
        maxColor > 0
          ? {
              r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
              g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
              b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
            }
          : { r: 0, g: 0, b: 0 }
    }
  }

  return columns
}

const drawPioneerPreviewWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: IPioneerPreviewWaveformData
) => {
  const columns = Array.isArray(data?.columns) ? data.columns : []
  const maxHeight = Math.max(
    1,
    Number(data?.maxHeight) ||
      columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
  )
  if (!columns.length || maxHeight <= 0) return

  const columnCount = Math.max(1, Math.floor(width))
  const samplesPerColumn = columns.length / columnCount
  const spacing = width / columnCount
  const drawWidth = Math.max(1, spacing)
  const scaleY = height / maxHeight

  for (let index = 0; index < columnCount; index++) {
    const start = Math.floor(index * samplesPerColumn)
    const end = Math.min(
      columns.length,
      Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
    )
    let selected = columns[start] || null
    for (let cursor = start; cursor < end; cursor++) {
      const candidate = columns[cursor]
      if (!candidate) continue
      if (!selected || (candidate.backHeight || 0) >= (selected.backHeight || 0)) {
        selected = candidate
      }
    }
    if (!selected) continue

    const backHeight = Math.max(0, Number(selected.backHeight) || 0)
    const frontHeight = Math.max(0, Number(selected.frontHeight) || 0)
    const x = Math.min(width - drawWidth, index * spacing)

    if (backHeight > 0) {
      const backPixelHeight = Math.max(1, backHeight * scaleY)
      ctx.fillStyle = `rgb(${selected.backColorR || 0}, ${selected.backColorG || 0}, ${selected.backColorB || 0})`
      ctx.fillRect(x, height - backPixelHeight, drawWidth, backPixelHeight)
    }

    if (frontHeight > 0) {
      const frontPixelHeight = Math.max(1, frontHeight * scaleY)
      ctx.fillStyle = `rgb(${selected.frontColorR || 0}, ${selected.frontColorG || 0}, ${selected.frontColorB || 0})`
      ctx.fillRect(x, height - frontPixelHeight, drawWidth, frontPixelHeight)
    }
  }
}

const drawSoundCloudWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: MixxxWaveformData
) => {
  const samples = buildMinMaxDataFromMixxx(data)
  if (!samples.length) return

  const targetBarWidth = 2
  const targetGap = 1
  const columnCount = Math.max(1, Math.floor(width / (targetBarWidth + targetGap)))
  const samplesPerColumn = samples.length / columnCount
  const spacing = width / columnCount
  const gap = Math.min(targetGap, spacing * 0.25)
  const drawWidth = Math.max(0.2, Math.min(targetBarWidth, Math.max(spacing - gap, spacing || 1)))
  const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0
  const midY = height / 2
  const isHalf = useHalfWaveform()
  const baselineY = isHalf ? height : midY
  const scaleY = isHalf ? baselineY * 0.98 : midY * 0.96

  ctx.fillStyle = '#cccccc'

  for (let index = 0; index < columnCount; index++) {
    const start = Math.floor(index * samplesPerColumn)
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
    )
    let peak = 0
    let sum = 0
    let count = 0

    for (let cursor = start; cursor < end; cursor++) {
      const { min, max } = samples[cursor]
      const amplitude = Math.max(Math.abs(min), Math.abs(max))
      if (amplitude > peak) peak = amplitude
      sum += amplitude
      count++
    }

    const average = count ? sum / count : 0
    const amplitude = Math.max(0, Math.min(1, peak * 0.7 + average * 0.3))
    const amplitudePx = Math.min(scaleY, Math.max(1, amplitude * scaleY))
    const rectHeight = Math.max(1, isHalf ? amplitudePx : amplitudePx * 2)
    const y = isHalf ? baselineY - rectHeight : midY - amplitudePx
    const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
    ctx.fillRect(x, y, drawWidth, rectHeight)
  }
}

const drawFineWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: MixxxWaveformData
) => {
  const samples = buildMinMaxDataFromMixxx(data)
  if (!samples.length) return

  const spacing = width / samples.length
  const gap = Math.min(1, spacing * 0.25)
  const drawWidth = Math.max(0.2, Math.min(2, Math.max(spacing - gap, spacing || 1)))
  const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0
  const midY = height / 2
  const isHalf = useHalfWaveform()
  const baselineY = isHalf ? height : midY
  const scaleY = isHalf ? baselineY : midY

  ctx.fillStyle = '#cccccc'

  for (let index = 0; index < samples.length; index++) {
    const { min, max } = samples[index]
    const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))

    if (isHalf) {
      const amplitude = Math.max(Math.abs(min), Math.abs(max))
      const rectHeight = Math.max(1, amplitude * scaleY)
      ctx.fillRect(x, baselineY - rectHeight, drawWidth, rectHeight)
      continue
    }

    const barMin = midY + min * midY
    const barMax = midY + max * midY
    ctx.fillRect(x, barMin, drawWidth, Math.max(1, barMax - barMin))
  }
}

const drawRgbWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: MixxxWaveformData
) => {
  const columns = computeMixxxColumnMetrics(Math.max(1, Math.floor(width)), data)
  if (!columns.length) return

  const isHalf = useHalfWaveform()
  const centerY = height / 2
  const maxAmplitude = isHalf ? height : centerY

  for (let x = 0; x < columns.length; x++) {
    const column = columns[x]
    const { r, g, b } = column.color
    if (!r && !g && !b) continue

    const amplitudeTop = Math.max(1, column.amplitudeLeft * maxAmplitude)
    const amplitudeBottom = Math.max(1, column.amplitudeRight * maxAmplitude)
    const rectHeight = isHalf
      ? Math.max(amplitudeTop, amplitudeBottom)
      : amplitudeTop + amplitudeBottom
    const y = isHalf ? height - rectHeight : centerY - amplitudeTop

    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    ctx.fillRect(x, y, 1, rectHeight)
  }
}

const drawWaveform = () => {
  const container = containerRef.value
  const canvas = canvasRef.value
  if (!container || !canvas) return

  const width = Math.max(1, container.clientWidth)
  const height = Math.max(1, container.clientHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  resizeCanvas(canvas, ctx, width, height)

  if (pioneerPreviewData.value) {
    drawPioneerPreviewWaveform(ctx, width, height, pioneerPreviewData.value)
    return
  }

  if (!waveformData.value) return

  const style = getWaveformStyle()
  if (style === WAVEFORM_STYLE_RGB) {
    drawRgbWaveform(ctx, width, height, waveformData.value)
    return
  }

  if (style === WAVEFORM_STYLE_FINE) {
    drawFineWaveform(ctx, width, height, waveformData.value)
    return
  }

  drawSoundCloudWaveform(ctx, width, height, waveformData.value)
}

const loadWaveformFromCache = async (
  channel: WaveformCacheChannel,
  filePath: string,
  currentToken: number
) => {
  try {
    const response = (await window.electron.ipcRenderer.invoke(channel, {
      filePaths: [filePath]
    })) as WaveformBatchResponse | null

    if (currentToken !== loadToken) return null
    return response?.items?.find((item) => item.filePath === filePath)?.data ?? null
  } catch {
    if (currentToken !== loadToken) return null
    return null
  }
}

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  waveformData.value = null
  pioneerPreviewData.value = null
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) return

  const pioneerAnalyzePath = String(currentSong?.pioneerAnalyzePath || '').trim()
  const pioneerRootPath = String(
    currentSong?.pioneerDeviceRootPath || runtime.pioneerDeviceLibrary.selectedDrivePath || ''
  ).trim()

  if (pioneerAnalyzePath && pioneerRootPath) {
    try {
      const response = (await window.electron.ipcRenderer.invoke(
        'pioneer-device-library:get-preview-waveforms',
        pioneerRootPath,
        [pioneerAnalyzePath]
      )) as PioneerPreviewWaveformResponse | null

      if (currentToken !== loadToken) return
      const preview =
        response?.items?.find((item) => item.analyzePath === pioneerAnalyzePath)?.data ?? null
      if (preview) {
        pioneerPreviewData.value = preview
        drawWaveform()
        return
      }
    } catch {}
  }

  const cachedWaveform =
    (await loadWaveformFromCache('waveform-cache:batch', filePath, currentToken)) ??
    (await loadWaveformFromCache('mixtape-waveform-cache:batch', filePath, currentToken))

  if (currentToken !== loadToken) return

  if (cachedWaveform) {
    waveformData.value = cachedWaveform
    drawWaveform()
    return
  }

  waveformData.value = null
  clearCanvas()
}

watch(
  () => [
    props.song?.filePath ?? '',
    props.song?.pioneerAnalyzePath ?? '',
    props.song?.pioneerDeviceRootPath ?? ''
  ],
  () => {
    void loadWaveform()
  },
  { immediate: true }
)

watch(
  () => runtime.setting?.waveformStyle,
  () => {
    drawWaveform()
  }
)

watch(
  () => runtime.setting?.waveformMode,
  () => {
    drawWaveform()
  }
)

onMounted(() => {
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      drawWaveform()
    })
    resizeObserver.observe(containerRef.value)
  }
  drawWaveform()
})

onUnmounted(() => {
  loadToken += 1
  stopScrubbing()
  if (seekRaf) {
    cancelAnimationFrame(seekRaf)
    seekRaf = 0
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})
</script>

<template>
  <div
    ref="containerRef"
    class="overview-waveform"
    :class="{ 'is-scrubbing': scrubbing }"
    @pointerdown.stop="handlePointerDown"
  >
    <canvas ref="canvasRef" class="overview-waveform__canvas"></canvas>
    <div
      v-if="playheadLeft !== null"
      class="overview-waveform__playhead"
      :style="{ left: playheadLeft }"
    ></div>
  </div>
</template>

<style scoped lang="scss">
.overview-waveform {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  cursor: ew-resize;
  touch-action: none;
}

.overview-waveform.is-scrubbing {
  cursor: grabbing;
}

.overview-waveform__canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.overview-waveform__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
  pointer-events: none;
}

:global(.theme-light) .overview-waveform__playhead {
  background: rgba(22, 22, 22, 0.92);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.24);
}
</style>
