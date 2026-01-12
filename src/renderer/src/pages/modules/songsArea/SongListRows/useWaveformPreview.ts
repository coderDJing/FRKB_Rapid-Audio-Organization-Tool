import { computed, markRaw, nextTick, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import type {
  MixxxWaveformData,
  RGBWaveformBandKey,
  WaveformStyle
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'

type VisibleSongItem = { song: ISongInfo; idx: number }

type MinMaxSample = {
  min: number
  max: number
}

type MixxxColumnMetrics = {
  amplitudeLeft: number
  amplitudeRight: number
  color: { r: number; g: number; b: number }
  progressColor: { r: number; g: number; b: number }
}

const WAVEFORM_STYLE_SOUND_CLOUD: WaveformStyle = 'SoundCloud'
const WAVEFORM_STYLE_FINE: WaveformStyle = 'Fine'
const WAVEFORM_STYLE_RGB: WaveformStyle = 'RGB'
const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE = 0.6
const MIXXX_RGB_COMPONENTS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}
const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const normalizeWaveformStyle = (
  style?: WaveformStyle | 'RekordboxMini' | 'Mixxx'
): WaveformStyle => {
  if (style === 'RekordboxMini' || style === 'Mixxx') return WAVEFORM_STYLE_RGB
  if (
    style === WAVEFORM_STYLE_RGB ||
    style === WAVEFORM_STYLE_FINE ||
    style === WAVEFORM_STYLE_SOUND_CLOUD
  ) {
    return style
  }
  return WAVEFORM_STYLE_SOUND_CLOUD
}

const buildMinMaxDataFromMixxx = (waveformData: MixxxWaveformData): MinMaxSample[] => {
  const low = waveformData.bands.low
  const mid = waveformData.bands.mid
  const high = waveformData.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (!frameCount) return []

  const data = new Array<MinMaxSample>(frameCount)

  for (let i = 0; i < frameCount; i++) {
    const lowLeft = low.peakLeft ? low.peakLeft[i] : low.left[i]
    const lowRight = low.peakRight ? low.peakRight[i] : low.right[i]
    const midLeft = mid.peakLeft ? mid.peakLeft[i] : mid.left[i]
    const midRight = mid.peakRight ? mid.peakRight[i] : mid.right[i]
    const highLeft = high.peakLeft ? high.peakLeft[i] : high.left[i]
    const highRight = high.peakRight ? high.peakRight[i] : high.right[i]

    const leftEnergy = Math.sqrt(lowLeft * lowLeft + midLeft * midLeft + highLeft * highLeft)
    const rightEnergy = Math.sqrt(lowRight * lowRight + midRight * midRight + highRight * highRight)

    const leftAmplitude = Math.min(1, leftEnergy / MIXXX_MAX_RGB_ENERGY)
    const rightAmplitude = Math.min(1, rightEnergy / MIXXX_MAX_RGB_ENERGY)

    data[i] = {
      min: -rightAmplitude,
      max: leftAmplitude
    }
  }

  return data
}

const computeMixxxColumnMetrics = (
  columnCount: number,
  waveformData: MixxxWaveformData | null
): MixxxColumnMetrics[] => {
  if (!waveformData || columnCount <= 0) return []

  const low = waveformData.bands.low
  const mid = waveformData.bands.mid
  const high = waveformData.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (frameCount === 0) return []

  const columns: MixxxColumnMetrics[] = new Array(columnCount)
  const dataSize = frameCount * 2
  const gain = dataSize / Math.max(1, columnCount)
  const lastVisualFrame = frameCount - 1

  for (let x = 0; x < columnCount; x++) {
    const xSampleWidth = gain * x
    const xVisualSampleIndex = xSampleWidth
    const maxSamplingRange = gain / 2

    let visualFrameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
    let visualFrameStop = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
    if (visualFrameStart < 0) visualFrameStart = 0
    if (visualFrameStop > lastVisualFrame) visualFrameStop = lastVisualFrame
    if (visualFrameStop < visualFrameStart) {
      visualFrameStop = visualFrameStart
    }

    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllLeft = 0
    let maxAllRight = 0

    for (let i = visualFrameStart; i <= visualFrameStop; i++) {
      const lowLeft = low.left[i]
      const lowRight = low.right[i]
      const midLeft = mid.left[i]
      const midRight = mid.right[i]
      const highLeft = high.left[i]
      const highRight = high.right[i]
      const lowLeftAmp = low.peakLeft ? low.peakLeft[i] : lowLeft
      const lowRightAmp = low.peakRight ? low.peakRight[i] : lowRight
      const midLeftAmp = mid.peakLeft ? mid.peakLeft[i] : midLeft
      const midRightAmp = mid.peakRight ? mid.peakRight[i] : midRight
      const highLeftAmp = high.peakLeft ? high.peakLeft[i] : highLeft
      const highRightAmp = high.peakRight ? high.peakRight[i] : highRight

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
    const color =
      maxColor > 0
        ? {
            r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
            g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
            b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
          }
        : { r: 0, g: 0, b: 0 }
    const progressColor =
      maxColor > 0
        ? {
            r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
            g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
            b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE)
          }
        : { r: 0, g: 0, b: 0 }

    const amplitudeLeft = Math.min(1, Math.sqrt(maxAllLeft) / MIXXX_MAX_RGB_ENERGY)
    const amplitudeRight = Math.min(1, Math.sqrt(maxAllRight) / MIXXX_MAX_RGB_ENERGY)

    columns[x] = {
      amplitudeLeft,
      amplitudeRight,
      color,
      progressColor
    }
  }

  return columns
}

export function useWaveformPreview(params: {
  visibleSongsWithIndex: Ref<VisibleSongItem[]>
  visibleColumns: Ref<ISongsAreaColumn[]>
  songListRootDir: Ref<string | undefined>
}) {
  const { visibleSongsWithIndex, visibleColumns, songListRootDir } = params
  const runtime = useRuntimeStore()

  const waveformColumn = computed(() =>
    visibleColumns.value.find((col) => col.key === 'waveformPreview')
  )
  const waveformVisible = computed(() => Boolean(waveformColumn.value))
  const waveformColumnWidth = computed(() => waveformColumn.value?.width ?? 0)

  const canvasMap = markRaw(new Map<string, HTMLCanvasElement>())
  const dataMap = markRaw(new Map<string, MixxxWaveformData | null>())
  const minMaxCache = markRaw(
    new Map<string, { source: MixxxWaveformData; samples: MinMaxSample[] }>()
  )
  const inflight = new Set<string>()
  const queuedMissing = new Set<string>()
  const MAX_CACHE_ENTRIES = 200
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  let drawRaf = 0
  const previewActive = ref(false)
  const previewFilePath = ref<string | null>(null)
  const previewPercent = ref(0)

  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'
  const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

  const setWaveformCanvasRef = (filePath: string, el: HTMLCanvasElement | null) => {
    if (!filePath) return
    if (el) {
      canvasMap.set(filePath, el)
      scheduleDraw()
    } else {
      canvasMap.delete(filePath)
    }
  }

  const getVisiblePaths = (): string[] => {
    const paths: string[] = []
    const seen = new Set<string>()
    for (const item of visibleSongsWithIndex.value || []) {
      const filePath = item?.song?.filePath
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
    return paths
  }

  const getWaveformClickPercent = (filePath: string, clientX: number) => {
    const canvas = canvasMap.get(filePath)
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    if (!rect.width) return 0
    return clamp01((clientX - rect.left) / rect.width)
  }

  const requestWaveformPreview = (song: ISongInfo, startPercent: number) => {
    const filePath = typeof song?.filePath === 'string' ? song.filePath : ''
    if (!filePath) return
    emitter.emit('waveform-preview:play', {
      filePath,
      startPercent: clamp01(startPercent)
    })
    previewActive.value = true
    previewFilePath.value = filePath
    previewPercent.value = clamp01(startPercent)
  }

  const stopWaveformPreview = () => {
    emitter.emit('waveform-preview:stop', { reason: 'explicit' })
  }

  const isWaveformPreviewActive = (filePath: string) =>
    previewActive.value && previewFilePath.value === filePath

  const getWaveformPreviewPlayheadStyle = (filePath: string) => {
    if (!isWaveformPreviewActive(filePath)) return {}
    const percent = clamp01(previewPercent.value)
    return {
      left: `${percent * 100}%`
    }
  }

  const getMinMaxSamples = (filePath: string, data: MixxxWaveformData): MinMaxSample[] => {
    const cached = minMaxCache.get(filePath)
    if (cached && cached.source === data) return cached.samples
    const samples = buildMinMaxDataFromMixxx(data)
    minMaxCache.set(filePath, { source: data, samples })
    return samples
  }

  const storeWaveformData = (filePath: string, data: MixxxWaveformData | null) => {
    if (!filePath) return
    if (dataMap.has(filePath)) {
      dataMap.delete(filePath)
    }
    dataMap.set(filePath, data)
    if (dataMap.size > MAX_CACHE_ENTRIES) {
      const oldest = dataMap.keys().next().value
      if (oldest) {
        dataMap.delete(oldest)
        minMaxCache.delete(oldest)
        queuedMissing.delete(oldest)
      }
    }
  }

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
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(pixelRatio, pixelRatio)
  }

  const drawMinMaxWaveform = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    samples: MinMaxSample[],
    style: WaveformStyle,
    isHalf: boolean,
    color: string
  ) => {
    if (!samples.length || width <= 0 || height <= 0) return
    const barWidth = style === WAVEFORM_STYLE_SOUND_CLOUD ? 2 : 1
    const gap = style === WAVEFORM_STYLE_SOUND_CLOUD ? 1 : 0
    const columnCount = Math.max(1, Math.floor(width / (barWidth + gap)))
    const totalBars = samples.length
    const samplesPerColumn = totalBars / columnCount
    const spacing = width / columnCount
    const drawWidth = Math.max(0.5, Math.min(barWidth, spacing))
    const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0

    const midY = height / 2
    const baselineY = isHalf ? height : midY
    const scaleY = isHalf ? baselineY : midY

    ctx.fillStyle = color || '#999999'

    for (let index = 0; index < columnCount; index++) {
      const start = Math.floor(index * samplesPerColumn)
      const end = Math.min(
        totalBars,
        Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
      )
      let peak = 0

      for (let i = start; i < end; i++) {
        const { min, max } = samples[i]
        const amplitude = Math.max(Math.abs(min), Math.abs(max))
        if (amplitude > peak) peak = amplitude
      }

      const amplitudePx = Math.max(1, peak * scaleY)
      if (isHalf) {
        const rectHeight = Math.max(1, amplitudePx)
        const y = baselineY - rectHeight
        const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
        ctx.fillRect(x, y, drawWidth, rectHeight)
      } else {
        const rectHeight = Math.max(1, amplitudePx * 2)
        const y = baselineY - amplitudePx
        const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
        ctx.fillRect(x, y, drawWidth, rectHeight)
      }
    }
  }

  const drawRgbWaveform = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    waveformData: MixxxWaveformData,
    isHalf: boolean,
    playedPercent: number
  ) => {
    const columns = computeMixxxColumnMetrics(Math.max(1, Math.floor(width)), waveformData)
    if (!columns.length) return

    const centerY = height / 2
    const maxAmplitude = isHalf ? height : centerY
    const playedColumns = Math.min(
      columns.length,
      Math.max(0, Math.floor(columns.length * playedPercent))
    )

    for (let x = 0; x < columns.length; x++) {
      const column = columns[x]
      const { r, g, b } = x < playedColumns ? column.progressColor : column.color
      if (!r && !g && !b) continue

      const amplitudeTop = Math.max(1, column.amplitudeLeft * maxAmplitude)
      const amplitudeBottom = Math.max(1, column.amplitudeRight * maxAmplitude)
      const rectHeight = isHalf
        ? Math.max(amplitudeTop, amplitudeBottom)
        : amplitudeTop + amplitudeBottom
      const yTop = isHalf ? height - rectHeight : centerY - amplitudeTop

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
      ctx.fillRect(x, yTop, 1, rectHeight)
    }
  }

  const drawWaveform = (filePath: string) => {
    const canvas = canvasMap.get(filePath)
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = canvas.clientWidth || 1
    const height = canvas.clientHeight || 1
    resizeCanvas(canvas, ctx, width, height)

    const data = dataMap.get(filePath) ?? null
    if (!data) return

    const style = normalizeWaveformStyle(runtime.setting?.waveformStyle)
    const isHalf = useHalfWaveform()

    if (style === WAVEFORM_STYLE_RGB) {
      const playedPercent = isWaveformPreviewActive(filePath) ? clamp01(previewPercent.value) : 0
      drawRgbWaveform(ctx, width, height, data, isHalf, playedPercent)
      return
    }

    const samples = getMinMaxSamples(filePath, data)
    const color = typeof window !== 'undefined' ? getComputedStyle(canvas).color : '#999999'
    drawMinMaxWaveform(ctx, width, height, samples, style, isHalf, color)
  }

  const drawVisible = () => {
    if (!waveformVisible.value) return
    const paths = getVisiblePaths()
    for (const filePath of paths) {
      drawWaveform(filePath)
    }
  }

  const scheduleDraw = () => {
    if (typeof requestAnimationFrame === 'undefined') {
      drawVisible()
      return
    }
    if (drawRaf) cancelAnimationFrame(drawRaf)
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      drawVisible()
    })
  }

  const fetchWaveformBatch = async (filePaths: string[]) => {
    if (!filePaths.length) return
    for (const filePath of filePaths) {
      inflight.add(filePath)
    }
    const listRoot = (songListRootDir.value || '').trim()
    let response: { items?: Array<{ filePath: string; data: MixxxWaveformData | null }> } | null =
      null
    try {
      response = await window.electron.ipcRenderer.invoke('waveform-cache:batch', {
        listRoot,
        filePaths
      })
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : null
    if (!items) {
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
      return
    }

    const itemMap = new Map(items.map((item) => [item.filePath, item.data ?? null]))
    const missing: string[] = []
    for (const filePath of filePaths) {
      const data = itemMap.has(filePath) ? itemMap.get(filePath) : null
      storeWaveformData(filePath, data ?? null)
      if (data) {
        queuedMissing.delete(filePath)
      } else {
        missing.push(filePath)
      }
      inflight.delete(filePath)
    }

    if (missing.length) {
      const toQueue = missing.filter((filePath) => !queuedMissing.has(filePath))
      if (toQueue.length) {
        for (const filePath of toQueue) {
          queuedMissing.add(filePath)
        }
        window.electron.ipcRenderer.send('key-analysis:queue-visible', { filePaths: toQueue })
      }
    }

    scheduleDraw()
  }

  const loadVisible = async () => {
    if (!waveformVisible.value) return
    const paths = getVisiblePaths()
    if (!paths.length) return
    const pending = paths.filter((filePath) => !dataMap.has(filePath) && !inflight.has(filePath))
    if (!pending.length) {
      scheduleDraw()
      return
    }
    await fetchWaveformBatch(pending)
  }

  const scheduleLoad = () => {
    if (loadTimer) clearTimeout(loadTimer)
    loadTimer = setTimeout(() => {
      loadTimer = null
      void loadVisible()
    }, 120)
  }

  const handleWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath || !waveformVisible.value) return
    if (!canvasMap.has(filePath)) return
    dataMap.delete(filePath)
    queuedMissing.delete(filePath)
    void fetchWaveformBatch([filePath])
  }

  const handleWaveformPreviewState = (payload: { filePath?: string; active?: boolean }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    const isActive = Boolean(payload?.active)
    if (!isActive) {
      const previousFilePath = previewFilePath.value
      if (!filePath || previewFilePath.value === filePath) {
        previewActive.value = false
        previewFilePath.value = null
        previewPercent.value = 0
      }
      if (previousFilePath) {
        drawWaveform(previousFilePath)
      }
      return
    }
    if (filePath) {
      previewActive.value = true
      previewFilePath.value = filePath
      drawWaveform(filePath)
    }
  }

  const handleWaveformPreviewProgress = (payload: { filePath?: string; percent?: number }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const percentRaw = typeof payload?.percent === 'number' ? payload.percent : 0
    previewActive.value = true
    previewFilePath.value = filePath
    previewPercent.value = clamp01(percentRaw)
    drawWaveform(filePath)
  }

  watch(
    () => visibleSongsWithIndex.value.map((item) => item.song?.filePath || '').join('|'),
    () => {
      if (!waveformVisible.value) return
      scheduleLoad()
      nextTick(() => scheduleDraw())
    },
    { immediate: true }
  )

  watch(
    () => waveformVisible.value,
    (visible) => {
      if (!visible) return
      scheduleLoad()
      nextTick(() => scheduleDraw())
    }
  )

  watch(
    () => waveformColumnWidth.value,
    () => {
      if (!waveformVisible.value) return
      scheduleDraw()
    }
  )

  watch(
    () => runtime.setting?.waveformStyle,
    () => {
      if (!waveformVisible.value) return
      scheduleDraw()
    }
  )

  watch(
    () => runtime.setting?.waveformMode,
    () => {
      if (!waveformVisible.value) return
      scheduleDraw()
    }
  )

  if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.on('song-waveform-updated', handleWaveformUpdated)
  }
  emitter.on('waveform-preview:state', handleWaveformPreviewState)
  emitter.on('waveform-preview:progress', handleWaveformPreviewProgress)

  onUnmounted(() => {
    if (loadTimer) clearTimeout(loadTimer)
    if (drawRaf) cancelAnimationFrame(drawRaf)
    if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.removeListener('song-waveform-updated', handleWaveformUpdated)
    }
    emitter.off('waveform-preview:state', handleWaveformPreviewState)
    emitter.off('waveform-preview:progress', handleWaveformPreviewProgress)
  })

  return {
    setWaveformCanvasRef,
    getWaveformClickPercent,
    requestWaveformPreview,
    stopWaveformPreview,
    isWaveformPreviewActive,
    getWaveformPreviewPlayheadStyle
  }
}
