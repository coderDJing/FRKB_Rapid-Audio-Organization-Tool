import { computed, markRaw, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type {
  IPioneerPreviewWaveformData,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../../../types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import {
  getRekordboxPreviewWaveformDoneEventChannel,
  getRekordboxPreviewWaveformItemEventChannel,
  getRekordboxPreviewWaveformStreamChannel,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import { t } from '@renderer/utils/translate'
import type {
  MixxxWaveformData,
  RGBWaveformBandKey,
  WaveformStyle
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RekordboxSourceKind } from '@shared/rekordboxSources'
import { createSongListWaveformPreviewWorker } from '@renderer/workers/songListWaveformPreview.workerClient'
import type {
  SongListWaveformWorkerData,
  SongListWaveformWorkerIncoming
} from '@renderer/workers/songListWaveformPreview.types'
type VisibleSongItem = { song: ISongInfo; idx: number }
type MinMaxSample = {
  min: number
  max: number
}
type WaveformCacheEntry =
  | {
      kind: 'mixxx'
      data: MixxxWaveformData
    }
  | {
      kind: 'pioneer'
      data: IPioneerPreviewWaveformData
    }
  | null
type WaveformPlaceholderState = 'loading' | 'unavailable' | 'ready'
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
const PIONEER_WAVEFORM_EAGER_COUNT = 8
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
  return WAVEFORM_STYLE_RGB
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
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)
const drawPioneerPreviewWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveformData: IPioneerPreviewWaveformData,
  playedPercent: number,
  progressColor: string
) => {
  const columns = Array.isArray(waveformData?.columns) ? waveformData.columns : []
  const maxHeight = Math.max(
    1,
    Number(waveformData?.maxHeight) ||
      columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
  )
  if (!columns.length || width <= 0 || height <= 0 || maxHeight <= 0) return
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
    for (let i = start; i < end; i++) {
      const candidate = columns[i]
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
  const clampedPlayed = clamp01(playedPercent)
  if (clampedPlayed <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = 0.32
  ctx.fillStyle = progressColor
  ctx.fillRect(0, 0, width * clampedPlayed, height)
  ctx.restore()
}
export function useWaveformPreview(params: {
  visibleSongsWithIndex: Ref<VisibleSongItem[]>
  visibleColumns: Ref<ISongsAreaColumn[]>
  songListRootDir: Ref<string | undefined>
  externalWaveformRootPath: Ref<string | undefined>
  actualVisibleStartIndex: Ref<number>
  actualVisibleEndIndex: Ref<number>
}) {
  const {
    visibleSongsWithIndex,
    visibleColumns,
    songListRootDir,
    externalWaveformRootPath,
    actualVisibleStartIndex,
    actualVisibleEndIndex
  } = params
  const runtime = useRuntimeStore()
  const waveformColumn = computed(() =>
    visibleColumns.value.find((col) => col.key === 'waveformPreview')
  )
  const waveformVisible = computed(() => Boolean(waveformColumn.value))
  const waveformColumnWidth = computed(() => waveformColumn.value?.width ?? 0)
  const canUseAsyncWaveformWorker =
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  const normalizePath = (value: string | undefined | null) =>
    String(value || '')
      .replace(/\//g, '\\')
      .toLowerCase()
  const canvasMap = markRaw(new Map<string, HTMLCanvasElement>())
  const workerCanvasMap = markRaw(new Map<string, HTMLCanvasElement>())
  const dataMap = markRaw(new Map<string, WaveformCacheEntry>())
  const placeholderStateMap = markRaw(new Map<string, WaveformPlaceholderState>())
  const placeholderReasonMap = markRaw(new Map<string, string>())
  const minMaxCache = markRaw(
    new Map<string, { source: MixxxWaveformData; samples: MinMaxSample[] }>()
  )
  const inflight = new Set<string>()
  const queuedMissing = new Set<string>()
  const MAX_CACHE_ENTRIES = 200
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  let drawRaf = 0
  let waveformWorker: Worker | null = null
  const previewActive = ref(false)
  const previewFilePath = ref<string | null>(null)
  const previewPercent = ref(0)
  const placeholderVersion = ref(0)
  let activePioneerStreamRequestId = ''
  const pioneerStreamFilePathMap = markRaw(new Map<string, string[]>())
  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'
  const resolveExternalRootPath = () => String(externalWaveformRootPath.value || '').trim()
  const touchPlaceholderState = () => (placeholderVersion.value += 1)
  const ensureWaveformWorker = () => {
    if (!canUseAsyncWaveformWorker) return null
    if (waveformWorker) return waveformWorker
    waveformWorker = createSongListWaveformPreviewWorker()
    waveformWorker.addEventListener('error', (event) => {
      const message = event instanceof ErrorEvent ? event.message : 'unknown worker error'
      console.error('[song-list-waveform-worker] error', {
        message,
        filename: (event as ErrorEvent)?.filename,
        lineno: (event as ErrorEvent)?.lineno,
        colno: (event as ErrorEvent)?.colno
      })
      try {
        window.electron.ipcRenderer.send(
          'outputLog',
          `[song-list-waveform-worker] error: ${message}`
        )
      } catch {}
    })
    waveformWorker.addEventListener('messageerror', () => {
      console.error('[song-list-waveform-worker] messageerror')
      try {
        window.electron.ipcRenderer.send('outputLog', '[song-list-waveform-worker] messageerror')
      } catch {}
    })
    return waveformWorker
  }
  const toWorkerData = (data: WaveformCacheEntry): SongListWaveformWorkerData => {
    if (!data) return null
    if (data.kind === 'pioneer') {
      return {
        kind: 'pioneer',
        data: data.data
      }
    }
    return {
      kind: 'mixxx',
      data: data.data
    }
  }
  const syncWaveformDataToWorker = (filePath: string, data: WaveformCacheEntry) => {
    if (!canUseAsyncWaveformWorker || !filePath) return
    const worker = ensureWaveformWorker()
    if (!worker) return
    const payload: SongListWaveformWorkerIncoming =
      data === null
        ? {
            type: 'clearData',
            payload: { filePath }
          }
        : {
            type: 'setData',
            payload: {
              filePath,
              data: toWorkerData(data)
            }
          }
    worker.postMessage(payload)
  }
  const renderWaveformWithWorker = (filePath: string) => {
    if (!canUseAsyncWaveformWorker) return
    const worker = ensureWaveformWorker()
    const canvas = canvasMap.get(filePath)
    if (!worker || !canvas) return
    const data = dataMap.get(filePath) ?? null
    if (!data) {
      const message: SongListWaveformWorkerIncoming = {
        type: 'clearCanvas',
        payload: { canvasId: filePath }
      }
      worker.postMessage(message)
      return
    }
    const computedStyle = typeof window !== 'undefined' ? getComputedStyle(canvas) : null
    const accent = computedStyle?.getPropertyValue('--accent') || ''
    const progressColor = accent.trim() || '#0078d4'
    const playedPercent = isWaveformPreviewActive(filePath) ? clamp01(previewPercent.value) : 0
    const message: SongListWaveformWorkerIncoming = {
      type: 'render',
      payload: {
        canvasId: filePath,
        filePath,
        width: canvas.clientWidth || 1,
        height: canvas.clientHeight || 1,
        pixelRatio: window.devicePixelRatio || 1,
        waveformStyle: normalizeWaveformStyle(runtime.setting?.waveformStyle),
        isHalf: useHalfWaveform(),
        baseColor: computedStyle?.color || '#999999',
        progressColor,
        playedPercent
      }
    }
    worker.postMessage(message)
  }
  const setWaveformCanvasRef = (filePath: string, el: HTMLCanvasElement | null) => {
    if (!filePath) return
    if (el) {
      canvasMap.set(filePath, el)
      if (canUseAsyncWaveformWorker) {
        const currentBoundCanvas = workerCanvasMap.get(filePath)
        if (currentBoundCanvas !== el) {
          if (currentBoundCanvas) {
            ensureWaveformWorker()?.postMessage({
              type: 'detachCanvas',
              payload: { canvasId: filePath }
            } satisfies SongListWaveformWorkerIncoming)
          }
          const offscreen = el.transferControlToOffscreen()
          ensureWaveformWorker()?.postMessage(
            {
              type: 'attachCanvas',
              payload: {
                canvasId: filePath,
                canvas: offscreen
              }
            } satisfies SongListWaveformWorkerIncoming,
            [offscreen]
          )
          workerCanvasMap.set(filePath, el)
          syncWaveformDataToWorker(filePath, dataMap.get(filePath) ?? null)
        }
      }
      scheduleDraw()
    } else {
      canvasMap.delete(filePath)
      if (canUseAsyncWaveformWorker && workerCanvasMap.get(filePath)) {
        ensureWaveformWorker()?.postMessage({
          type: 'detachCanvas',
          payload: { canvasId: filePath }
        } satisfies SongListWaveformWorkerIncoming)
        workerCanvasMap.delete(filePath)
      }
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
  const resolveVisibleSongByFilePath = (filePath: string) => {
    const normalizedTargetPath = normalizePath(filePath)
    return (
      visibleSongsWithIndex.value.find(
        (item) => normalizePath(String(item?.song?.filePath || '')) === normalizedTargetPath
      )?.song || null
    )
  }
  const buildPioneerStreamRequestId = () =>
    `pioneer-waveform:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const resetPioneerStreamState = () => {
    for (const [, filePaths] of pioneerStreamFilePathMap) {
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
    }
    activePioneerStreamRequestId = ''
    pioneerStreamFilePathMap.clear()
  }
  const orderPioneerRequestsForViewport = (
    requests: Array<{
      filePath: string
      analyzePath: string
      sourceKind: RekordboxSourceKind
    }>
  ) => {
    if (!requests.length) return requests
    const requestByFilePath = new Map(requests.map((request) => [request.filePath, request]))
    const eager: typeof requests = []
    const visibleRest: typeof requests = []
    const buffered: typeof requests = []
    let eagerCount = 0
    for (const item of visibleSongsWithIndex.value || []) {
      const filePath = String(item?.song?.filePath || '').trim()
      const request = requestByFilePath.get(filePath)
      if (!request) continue
      requestByFilePath.delete(filePath)
      const idx = Number(item.idx)
      const isActuallyVisible =
        idx >= actualVisibleStartIndex.value && idx < actualVisibleEndIndex.value
      if (isActuallyVisible && eagerCount < PIONEER_WAVEFORM_EAGER_COUNT) {
        eager.push(request)
        eagerCount += 1
      } else if (isActuallyVisible) {
        visibleRest.push(request)
      } else {
        buffered.push(request)
      }
    }
    const remainder = Array.from(requestByFilePath.values())
    return [...eager, ...visibleRest, ...buffered, ...remainder]
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
  const setWaveformPlaceholderLoading = (filePath: string) => {
    if (!filePath) return
    placeholderStateMap.set(filePath, 'loading')
    placeholderReasonMap.delete(filePath)
    touchPlaceholderState()
  }
  const setWaveformPlaceholderUnavailable = (filePath: string, reason?: string) => {
    if (!filePath) return
    placeholderStateMap.set(filePath, 'unavailable')
    if (reason) {
      placeholderReasonMap.set(filePath, reason)
    } else {
      placeholderReasonMap.delete(filePath)
    }
    touchPlaceholderState()
  }
  const setWaveformPlaceholderReady = (filePath: string) => {
    if (!filePath) return
    placeholderStateMap.set(filePath, 'ready')
    placeholderReasonMap.delete(filePath)
    touchPlaceholderState()
  }
  const getWaveformPlaceholderText = (filePath: string) => {
    placeholderVersion.value
    const state = placeholderStateMap.get(filePath)
    if (state === 'loading') return t('tracks.waveformPreviewLoading')
    if (state === 'unavailable') return t('tracks.waveformPreviewUnavailable')
    return ''
  }
  const getWaveformPlaceholderTitle = (filePath: string) => {
    placeholderVersion.value
    if (placeholderStateMap.get(filePath) !== 'unavailable') return ''
    return placeholderReasonMap.get(filePath) || ''
  }
  const storeWaveformData = (filePath: string, data: WaveformCacheEntry) => {
    if (!filePath) return
    if (dataMap.has(filePath)) {
      dataMap.delete(filePath)
    }
    dataMap.set(filePath, data)
    syncWaveformDataToWorker(filePath, data)
    if (dataMap.size > MAX_CACHE_ENTRIES) {
      const oldest = dataMap.keys().next().value
      if (oldest) {
        dataMap.delete(oldest)
        minMaxCache.delete(oldest)
        queuedMissing.delete(oldest)
        placeholderStateMap.delete(oldest)
        placeholderReasonMap.delete(oldest)
        syncWaveformDataToWorker(oldest, null)
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
    baseColor: string,
    progressColor: string,
    playedPercent: number
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
    const rects: Array<{ x: number; y: number; width: number; height: number }> = []
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
      const rectHeight = isHalf ? Math.max(1, amplitudePx) : Math.max(1, amplitudePx * 2)
      const y = isHalf ? baselineY - rectHeight : baselineY - amplitudePx
      const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
      rects.push({ x, y, width: drawWidth, height: rectHeight })
    }
    const paintRects = (fillStyle: string) => {
      ctx.fillStyle = fillStyle || '#999999'
      for (const rect of rects) {
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      }
    }
    paintRects(baseColor)
    const clampedPlayed = clamp01(playedPercent)
    if (clampedPlayed > 0) {
      const playedWidth = width * clampedPlayed
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, playedWidth, height)
      ctx.clip()
      paintRects(progressColor)
      ctx.restore()
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
    if (canUseAsyncWaveformWorker) {
      renderWaveformWithWorker(filePath)
      return
    }
    const canvas = canvasMap.get(filePath)
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = canvas.clientWidth || 1
    const height = canvas.clientHeight || 1
    resizeCanvas(canvas, ctx, width, height)
    const data = dataMap.get(filePath) ?? null
    if (!data) return
    const computedStyle = typeof window !== 'undefined' ? getComputedStyle(canvas) : null
    const accent = computedStyle?.getPropertyValue('--accent') || ''
    const progressColor = accent.trim() || '#0078d4'
    const playedPercent = isWaveformPreviewActive(filePath) ? clamp01(previewPercent.value) : 0
    if (data.kind === 'pioneer') {
      drawPioneerPreviewWaveform(ctx, width, height, data.data, playedPercent, progressColor)
      return
    }
    const style = normalizeWaveformStyle(runtime.setting?.waveformStyle)
    const isHalf = useHalfWaveform()
    if (style === WAVEFORM_STYLE_RGB) {
      drawRgbWaveform(ctx, width, height, data.data, isHalf, playedPercent)
      return
    }
    const samples = getMinMaxSamples(filePath, data.data)
    const baseColor = computedStyle?.color || '#999999'
    drawMinMaxWaveform(
      ctx,
      width,
      height,
      samples,
      style,
      isHalf,
      baseColor,
      progressColor,
      playedPercent
    )
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
      setWaveformPlaceholderLoading(filePath)
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
      console.warn('[songs-waveform] waveform-cache:batch returned no items', {
        fileCount: filePaths.length
      })
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
      return
    }
    const itemMap = new Map(items.map((item) => [item.filePath, item.data ?? null]))
    const missing: string[] = []
    for (const filePath of filePaths) {
      const data = itemMap.has(filePath) ? itemMap.get(filePath) : null
      storeWaveformData(
        filePath,
        data
          ? {
              kind: 'mixxx',
              data
            }
          : null
      )
      if (data) {
        setWaveformPlaceholderReady(filePath)
        queuedMissing.delete(filePath)
      } else {
        missing.push(filePath)
      }
      inflight.delete(filePath)
    }
    if (missing.length) {
      console.info('[songs-waveform] waveform-cache misses', {
        missingCount: missing.length,
        sample: missing.slice(0, 5)
      })
      const toQueue = missing.filter((filePath) => !queuedMissing.has(filePath))
      if (toQueue.length) {
        for (const filePath of toQueue) {
          queuedMissing.add(filePath)
        }
        window.electron.ipcRenderer.send('key-analysis:queue-visible', { filePaths: toQueue })
      }
    } else {
      console.info('[songs-waveform] waveform-cache hits', {
        fileCount: filePaths.length,
        sample: filePaths.slice(0, 5)
      })
    }
    scheduleDraw()
  }
  const fetchExternalWaveformStream = async (
    requests: Array<{
      filePath: string
      analyzePath: string
      sourceKind: RekordboxSourceKind
    }>
  ) => {
    if (!requests.length) return
    const orderedRequests = orderPioneerRequestsForViewport(requests)
    const sourceKind = orderedRequests[0].sourceKind
    const rootPath = resolveExternalRootPath()
    if (!rootPath) {
      for (const request of orderedRequests) {
        inflight.delete(request.filePath)
      }
      return
    }
    resetPioneerStreamState()
    for (const request of orderedRequests) {
      inflight.add(request.filePath)
      setWaveformPlaceholderLoading(request.filePath)
    }
    const requestId = buildPioneerStreamRequestId()
    activePioneerStreamRequestId = requestId
    for (const request of orderedRequests) {
      const list = pioneerStreamFilePathMap.get(request.analyzePath) || []
      list.push(request.filePath)
      pioneerStreamFilePathMap.set(request.analyzePath, list)
    }
    try {
      window.electron.ipcRenderer.send(getRekordboxPreviewWaveformStreamChannel(sourceKind), {
        requestId,
        rootPath,
        analyzePaths: orderedRequests.map((request) => request.analyzePath)
      })
    } catch (error) {
      for (const request of orderedRequests) {
        inflight.delete(request.filePath)
      }
      resetPioneerStreamState()
      throw error
    }
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
    const externalRequests: Array<{
      filePath: string
      analyzePath: string
      sourceKind: RekordboxSourceKind
    }> = []
    const libraryFilePaths: string[] = []
    const fallbackSourceKind = runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
    for (const filePath of pending) {
      const song = resolveVisibleSongByFilePath(filePath)
      const source = resolveSongExternalWaveformSource(song, {
        rootPath: resolveExternalRootPath(),
        sourceKind: fallbackSourceKind
      })
      if (source) {
        externalRequests.push({
          filePath,
          analyzePath: source.analyzePath,
          sourceKind: source.sourceKind
        })
      } else if (resolveExternalRootPath()) {
        storeWaveformData(filePath, null)
        setWaveformPlaceholderUnavailable(filePath, 'missing analyze path')
        console.warn('[external-waveform] preview waveform unavailable', {
          filePath,
          analyzePath: '',
          reason: 'missing analyze path'
        })
      } else {
        libraryFilePaths.push(filePath)
      }
    }
    if (libraryFilePaths.length) {
      await fetchWaveformBatch(libraryFilePaths)
    }
    if (externalRequests.length) {
      await fetchExternalWaveformStream(externalRequests)
    }
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
    console.info('[songs-waveform] song-waveform-updated', { filePath })
    const song = resolveVisibleSongByFilePath(filePath)
    const visibleFilePath = typeof song?.filePath === 'string' ? song.filePath : ''
    if (!visibleFilePath) return
    if (!canvasMap.has(visibleFilePath)) return
    if (
      resolveSongExternalWaveformSource(song, {
        rootPath: resolveExternalRootPath(),
        sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
      })
    ) {
      return
    }
    setWaveformPlaceholderLoading(visibleFilePath)
    dataMap.delete(visibleFilePath)
    syncWaveformDataToWorker(visibleFilePath, null)
    ensureWaveformWorker()?.postMessage({
      type: 'clearCanvas',
      payload: { canvasId: visibleFilePath }
    } satisfies SongListWaveformWorkerIncoming)
    queuedMissing.delete(visibleFilePath)
    void fetchWaveformBatch([visibleFilePath])
  }
  const handlePioneerPreviewWaveformItem = (
    _event: unknown,
    payload: {
      requestId?: string
      analyzePath?: string
      data?: IPioneerPreviewWaveformData | null
      error?: string
    }
  ) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId || requestId !== activePioneerStreamRequestId) return
    const analyzePath = String(payload?.analyzePath || '').trim()
    if (!analyzePath) return
    const filePaths = pioneerStreamFilePathMap.get(analyzePath) || []
    if (!filePaths.length) return
    const data = payload?.data ?? null
    for (const filePath of filePaths) {
      storeWaveformData(
        filePath,
        data
          ? {
              kind: 'pioneer',
              data
            }
          : null
      )
      inflight.delete(filePath)
      if (data) {
        setWaveformPlaceholderReady(filePath)
      } else {
        setWaveformPlaceholderUnavailable(filePath, payload?.error ? String(payload.error) : '')
      }
      if (!data && payload?.error) {
        console.warn('[pioneer-waveform] preview waveform unavailable', {
          filePath,
          analyzePath,
          reason: String(payload.error)
        })
      }
    }
    pioneerStreamFilePathMap.delete(analyzePath)
    scheduleDraw()
  }
  const handlePioneerPreviewWaveformDone = (
    _event: unknown,
    payload: {
      requestId?: string
      error?: string
    }
  ) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId || requestId !== activePioneerStreamRequestId) return
    for (const [, filePaths] of pioneerStreamFilePathMap) {
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
    }
    if (payload?.error) {
      console.warn('[pioneer-waveform] preview waveform stream failed', {
        requestId,
        reason: String(payload.error)
      })
    }
    for (const [, filePaths] of pioneerStreamFilePathMap) {
      for (const filePath of filePaths) {
        setWaveformPlaceholderUnavailable(
          filePath,
          payload?.error ? String(payload.error) : 'missing preview waveform item'
        )
      }
    }
    resetPioneerStreamState()
    scheduleDraw()
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
      if (resolveExternalRootPath()) {
        resetPioneerStreamState()
      }
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
    () => resolveExternalRootPath(),
    () => {
      resetPioneerStreamState()
      if (canUseAsyncWaveformWorker) {
        for (const filePath of dataMap.keys()) {
          syncWaveformDataToWorker(filePath, null)
        }
        for (const canvasId of workerCanvasMap.keys()) {
          ensureWaveformWorker()?.postMessage({
            type: 'clearCanvas',
            payload: { canvasId }
          } satisfies SongListWaveformWorkerIncoming)
        }
      }
      dataMap.clear()
      inflight.clear()
      minMaxCache.clear()
      queuedMissing.clear()
      placeholderStateMap.clear()
      placeholderReasonMap.clear()
      if (!waveformVisible.value) return
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
    for (const sourceKind of ['usb', 'desktop'] as const) {
      window.electron.ipcRenderer.on(
        getRekordboxPreviewWaveformItemEventChannel(sourceKind),
        handlePioneerPreviewWaveformItem
      )
      window.electron.ipcRenderer.on(
        getRekordboxPreviewWaveformDoneEventChannel(sourceKind),
        handlePioneerPreviewWaveformDone
      )
    }
  }
  emitter.on('waveform-preview:state', handleWaveformPreviewState)
  emitter.on('waveform-preview:progress', handleWaveformPreviewProgress)
  onBeforeUnmount(() => {
    if (loadTimer) clearTimeout(loadTimer)
    if (drawRaf) cancelAnimationFrame(drawRaf)
    resetPioneerStreamState()
    if (waveformWorker) {
      waveformWorker.terminate()
      waveformWorker = null
    }
    workerCanvasMap.clear()
    if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.removeListener('song-waveform-updated', handleWaveformUpdated)
      for (const sourceKind of ['usb', 'desktop'] as const) {
        window.electron.ipcRenderer.removeListener(
          getRekordboxPreviewWaveformItemEventChannel(sourceKind),
          handlePioneerPreviewWaveformItem
        )
        window.electron.ipcRenderer.removeListener(
          getRekordboxPreviewWaveformDoneEventChannel(sourceKind),
          handlePioneerPreviewWaveformDone
        )
      }
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
    getWaveformPreviewPlayheadStyle,
    getWaveformPlaceholderText,
    getWaveformPlaceholderTitle
  }
}
