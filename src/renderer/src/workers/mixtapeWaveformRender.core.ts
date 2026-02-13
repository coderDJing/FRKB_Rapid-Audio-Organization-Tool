import { createFrameRenderer } from './mixtapeWaveformRender.frame'
import { createTileRenderer } from './mixtapeWaveformRender.tile'
import type {
  PreRenderPayload,
  RawWaveformData,
  RenderFramePayload,
  RenderTilePayload
} from './mixtapeWaveformRender.types'
import type { MixxxWaveformData, RawWaveformLevel } from './mixtapeWaveformRender.types'

const MIXTAPE_WEBGL_ENABLED = true
const MIXTAPE_BUFFER_MULTIPLIER = 3
const FRAME_RENDER_INTERVAL_MS = 16
const PRE_RENDER_PAUSE_ON_INTERACTION_MS = 16
const PRE_RENDER_PROGRESS_MIN_INTERVAL_MS = 66
const RAW_WAVEFORM_MIN_ZOOM = 0.1
const WAVEFORM_TILE_WIDTH = 1200
const GRID_BAR_ONLY_ZOOM = 0.6
const GRID_BAR_WIDTH_MIN = 1.6
const GRID_BAR_WIDTH_MAX = 2.6
const GRID_BAR_WIDTH_MAX_ZOOM = 1.2
const MIXTAPE_SUMMARY_ZOOM = 0
const MIXTAPE_DEBUG_TRACK_LINES = false
const MIXXX_RGB_COMPONENTS = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

const mixxxCache = new Map<string, MixxxWaveformData>()
const rawCache = new Map<string, RawWaveformData>()
const rawPyramidCache = new Map<string, RawWaveformLevel[]>()

const postToMain = (message: any, transfer?: Transferable[]) => {
  if (transfer && transfer.length) {
    ;(self as any).postMessage(message, transfer)
    return
  }
  ;(self as any).postMessage(message)
}

const tileRenderer = createTileRenderer({
  mixxxCache,
  rawCache,
  rawPyramidCache,
  rawWaveformMinZoom: RAW_WAVEFORM_MIN_ZOOM,
  summaryZoom: MIXTAPE_SUMMARY_ZOOM,
  mixxxRgbComponents: MIXXX_RGB_COMPONENTS,
  postToMain
})

const frameRenderer = createFrameRenderer({
  mixTapeWebglEnabled: MIXTAPE_WEBGL_ENABLED,
  mixTapeBufferMultiplier: MIXTAPE_BUFFER_MULTIPLIER,
  debugTrackLines: MIXTAPE_DEBUG_TRACK_LINES,
  rawWaveformMinZoom: RAW_WAVEFORM_MIN_ZOOM,
  gridBarOnlyZoom: GRID_BAR_ONLY_ZOOM,
  gridBarWidthMin: GRID_BAR_WIDTH_MIN,
  gridBarWidthMax: GRID_BAR_WIDTH_MAX,
  gridBarWidthMaxZoom: GRID_BAR_WIDTH_MAX_ZOOM,
  waveformTileWidth: WAVEFORM_TILE_WIDTH,
  renderTileBitmap: tileRenderer.renderTileBitmap,
  drawTrackGridLines: tileRenderer.drawTrackGridLines
})

let preRenderQueue: RenderTilePayload[] = []
let preRenderCursor = 0
let preRenderToken = 0
let preRenderTotal = 0
let preRenderTimer: ReturnType<typeof setTimeout> | null = null

let framePreRenderQueue: RenderFramePayload[] = []
let framePreRenderCursor = 0
let framePreRenderToken = 0
let framePreRenderTotal = 0
let framePreRenderTimer: ReturnType<typeof setTimeout> | null = null

let lastPreRenderProgressAt = 0
let lastPreRenderProgressDone = -1
let lastPreRenderProgressTotal = -1

let pendingFrame: RenderFramePayload | null = null
let frameScheduled = false

const resetPreRenderProgressThrottle = () => {
  lastPreRenderProgressAt = 0
  lastPreRenderProgressDone = -1
  lastPreRenderProgressTotal = -1
}

const postPreRenderProgress = (done: number, total: number, force: boolean = false) => {
  const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0)
  const safeDone = Math.min(safeTotal, Math.max(0, Number.isFinite(done) ? Math.floor(done) : 0))
  const now = performance.now()
  if (!force) {
    if (safeDone === lastPreRenderProgressDone && safeTotal === lastPreRenderProgressTotal) {
      return
    }
    if (
      safeDone < safeTotal &&
      lastPreRenderProgressAt > 0 &&
      now - lastPreRenderProgressAt < PRE_RENDER_PROGRESS_MIN_INTERVAL_MS
    ) {
      return
    }
  }
  lastPreRenderProgressAt = now
  lastPreRenderProgressDone = safeDone
  lastPreRenderProgressTotal = safeTotal
  postToMain({ type: 'preRenderProgress', done: safeDone, total: safeTotal })
}

const cancelFramePreRender = () => {
  framePreRenderToken += 1
  framePreRenderQueue = []
  framePreRenderCursor = 0
  framePreRenderTotal = 0
  if (framePreRenderTimer) {
    clearTimeout(framePreRenderTimer)
    framePreRenderTimer = null
  }
}

const cancelPreRender = () => {
  preRenderToken += 1
  preRenderQueue = []
  preRenderCursor = 0
  preRenderTotal = 0
  if (preRenderTimer) {
    clearTimeout(preRenderTimer)
    preRenderTimer = null
  }
  cancelFramePreRender()
  resetPreRenderProgressThrottle()
  postPreRenderProgress(0, 0, true)
}

const clearAllCaches = () => {
  frameRenderer.clearAllCaches()
  mixxxCache.clear()
  rawCache.clear()
  rawPyramidCache.clear()
}

const processPreRenderQueue = (token: number) => {
  if (token !== preRenderToken) return
  const queue = preRenderQueue
  if (!queue.length) {
    postToMain({ type: 'preRenderDone' })
    return
  }
  if (pendingFrame || frameScheduled) {
    preRenderTimer = setTimeout(
      () => processPreRenderQueue(token),
      PRE_RENDER_PAUSE_ON_INTERACTION_MS
    )
    return
  }
  const startTime = performance.now()
  const budget = 12
  while (preRenderCursor < queue.length && performance.now() - startTime < budget) {
    const task = queue[preRenderCursor]
    frameRenderer.warmTileTexture(task)
    preRenderCursor += 1
  }
  postPreRenderProgress(preRenderCursor, preRenderTotal)
  if (preRenderCursor < queue.length) {
    preRenderTimer = setTimeout(() => processPreRenderQueue(token), 0)
  } else {
    postPreRenderProgress(preRenderTotal, preRenderTotal, true)
    postToMain({ type: 'preRenderDone' })
  }
}

const startPreRender = (tasks: RenderTilePayload[]) => {
  cancelPreRender()
  if (!tasks.length) {
    postToMain({ type: 'preRenderDone' })
    return
  }
  preRenderToken += 1
  preRenderQueue = tasks
  preRenderCursor = 0
  preRenderTotal = tasks.length
  const targetLimit = frameRenderer.getTileCacheSize() + preRenderTotal + 20
  frameRenderer.ensureTileCacheLimit(targetLimit)
  resetPreRenderProgressThrottle()
  postPreRenderProgress(0, preRenderTotal, true)
  preRenderTimer = setTimeout(() => processPreRenderQueue(preRenderToken), 0)
}

const processFramePreRenderQueue = (token: number) => {
  if (token !== framePreRenderToken) return
  const queue = framePreRenderQueue
  if (!queue.length) {
    postToMain({ type: 'preRenderDone' })
    return
  }
  if (pendingFrame) {
    framePreRenderTimer = setTimeout(() => processFramePreRenderQueue(token), 0)
    return
  }
  const startTime = performance.now()
  const budget = 12
  while (framePreRenderCursor < queue.length && performance.now() - startTime < budget) {
    const task = queue[framePreRenderCursor]
    frameRenderer.renderFrame(task, { cacheOnly: true })
    framePreRenderCursor += 1
  }
  postPreRenderProgress(framePreRenderCursor, framePreRenderTotal)
  if (framePreRenderCursor < queue.length) {
    framePreRenderTimer = setTimeout(() => processFramePreRenderQueue(token), 0)
  } else {
    postPreRenderProgress(framePreRenderTotal, framePreRenderTotal, true)
    postToMain({ type: 'preRenderDone' })
  }
}

const startFramePreRender = (tasks: RenderFramePayload[]) => {
  cancelFramePreRender()
  if (!tasks.length) {
    postToMain({ type: 'preRenderDone' })
    return
  }
  framePreRenderToken += 1
  framePreRenderQueue = tasks
  framePreRenderCursor = 0
  framePreRenderTotal = tasks.length
  resetPreRenderProgressThrottle()
  postPreRenderProgress(0, framePreRenderTotal, true)
  framePreRenderTimer = setTimeout(() => processFramePreRenderQueue(framePreRenderToken), 0)
}

const scheduleFrameRender = () => {
  if (frameScheduled) return
  frameScheduled = true
  setTimeout(() => {
    frameScheduled = false
    const payload = pendingFrame
    pendingFrame = null
    if (payload) {
      frameRenderer.renderFrame(payload)
    }
    if (pendingFrame) {
      scheduleFrameRender()
    }
  }, FRAME_RENDER_INTERVAL_MS)
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: any }
  if (!message || !message.type) return
  if (message.type === 'initCanvas') {
    const { canvas } = message.payload || {}
    if (canvas) {
      frameRenderer.initCanvas(canvas as OffscreenCanvas)
    }
    return
  }
  if (message.type === 'storeMixxx') {
    const { filePath, data } = message.payload || {}
    if (!filePath) return
    if (data) {
      mixxxCache.set(filePath, data)
    } else {
      mixxxCache.delete(filePath)
    }
    return
  }
  if (message.type === 'storeRaw') {
    const { filePath, data } = message.payload || {}
    if (!filePath) return
    if (data) {
      rawCache.set(filePath, data)
      rawPyramidCache.set(filePath, tileRenderer.buildRawWaveformPyramid(data))
    } else {
      rawCache.delete(filePath)
      rawPyramidCache.delete(filePath)
    }
    return
  }
  if (message.type === 'clearTileCache') {
    const { filePath } = message.payload || {}
    if (filePath) {
      frameRenderer.clearTileCacheForFile(filePath)
    }
    return
  }
  if (message.type === 'clearAllCaches') {
    clearAllCaches()
    return
  }
  if (message.type === 'cancelPreRender') {
    cancelPreRender()
    return
  }
  if (message.type === 'preRenderTiles') {
    const payload = message.payload as PreRenderPayload | undefined
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : []
    startPreRender(tasks)
    return
  }
  if (message.type === 'preRenderFrames') {
    const payload = message.payload as { tasks?: RenderFramePayload[] } | undefined
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : []
    startFramePreRender(tasks)
    return
  }
  if (message.type === 'renderTile') {
    const payload = message.payload as RenderTilePayload
    if (!payload || !payload.cacheKey || !payload.filePath) return
    tileRenderer.renderTileMessage(payload)
    return
  }
  if (message.type === 'renderFrame') {
    const payload = message.payload as RenderFramePayload
    if (!payload || !payload.width || !payload.height) return
    pendingFrame = payload
    scheduleFrameRender()
    return
  }
}
