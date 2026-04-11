import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
import { drawBeatAlignRekordboxWaveform } from '@renderer/components/mixtapeBeatAlignWaveform'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { resizeCanvasWithScaleMetrics } from '@renderer/utils/canvasScale'
import type {
  HorizontalBrowseDetailWaveformTileRequest,
  HorizontalBrowseDetailWaveformWorkerIncoming,
  HorizontalBrowseDetailWaveformWorkerOutgoing
} from './horizontalBrowseDetailWaveform.types'

const rawCache = new Map<string, RawWaveformData>()

let tileCanvas: OffscreenCanvas | null = null
let tileCtx: OffscreenCanvasRenderingContext2D | null = null
let queueToken = 0
let renderQueue: HorizontalBrowseDetailWaveformTileRequest[] = []
let renderTimer: ReturnType<typeof setTimeout> | null = null

const ensureTileCanvas = (
  width: number,
  height: number,
  pixelRatio: number
): OffscreenCanvasRenderingContext2D | null => {
  const safeWidth = Math.max(1, Math.floor(width))
  const safeHeight = Math.max(1, Math.floor(height))
  if (!tileCanvas) {
    tileCanvas = new OffscreenCanvas(safeWidth, safeHeight)
    tileCtx = tileCanvas.getContext('2d')
  }
  if (!tileCanvas || !tileCtx) return null
  resizeCanvasWithScaleMetrics(tileCanvas, tileCtx, safeWidth, safeHeight, pixelRatio)
  return tileCtx
}

const postToMain = (
  message: HorizontalBrowseDetailWaveformWorkerOutgoing,
  transfer?: Transferable[]
) => {
  const scope = self as typeof globalThis & {
    postMessage: (
      payload: HorizontalBrowseDetailWaveformWorkerOutgoing,
      transfer?: Transferable[]
    ) => void
  }
  if (transfer?.length) {
    scope.postMessage(message, transfer)
    return
  }
  scope.postMessage(message)
}

const dedupeRequests = (requests: HorizontalBrowseDetailWaveformTileRequest[]) => {
  const seen = new Set<string>()
  const deduped: HorizontalBrowseDetailWaveformTileRequest[] = []
  for (const request of requests) {
    if (!request?.cacheKey || seen.has(request.cacheKey)) continue
    seen.add(request.cacheKey)
    deduped.push(request)
  }
  return deduped
}

const renderTileBitmap = (request: HorizontalBrowseDetailWaveformTileRequest) => {
  const raw = rawCache.get(request.filePath)
  if (!raw) return null
  const ctx = ensureTileCanvas(request.width, request.height, request.pixelRatio)
  if (!ctx || !tileCanvas) return null

  const mixxxData = createRawPlaceholderMixxxData(raw)

  drawBeatAlignRekordboxWaveform(ctx, {
    width: request.width,
    height: request.height,
    bpm: 0,
    firstBeatMs: 0,
    barBeatOffset: 0,
    rangeStartSec: request.rangeStartSec,
    rangeDurationSec: request.rangeDurationSec,
    mixxxData,
    rawData: raw,
    showBackground: false,
    showBeatGrid: false,
    showDetailHighlights: true,
    showCenterLine: false,
    maxSamplesPerPixel: request.maxSamplesPerPixel,
    waveformLayout: request.waveformLayout,
    themeVariant: request.themeVariant
  })

  return tileCanvas.transferToImageBitmap()
}

const scheduleQueueProcessing = (token: number) => {
  if (renderTimer) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
  renderTimer = setTimeout(() => {
    renderTimer = null
    if (token !== queueToken) return
    const startedAt = performance.now()
    const budgetMs = 14
    while (renderQueue.length && token === queueToken && performance.now() - startedAt < budgetMs) {
      const request = renderQueue.shift()
      if (!request) continue
      const bitmap = renderTileBitmap(request)
      postToMain(
        {
          type: 'tileRendered',
          payload: {
            requestToken: request.requestToken,
            filePath: request.filePath,
            cacheKey: request.cacheKey,
            rangeStartSec: request.rangeStartSec,
            rangeDurationSec: request.rangeDurationSec,
            width: request.width,
            height: request.height,
            pixelRatio: request.pixelRatio,
            bitmap
          }
        },
        bitmap ? [bitmap] : undefined
      )
    }
    if (renderQueue.length && token === queueToken) {
      scheduleQueueProcessing(token)
    }
  }, 0)
}

self.onmessage = (event: MessageEvent<HorizontalBrowseDetailWaveformWorkerIncoming>) => {
  const message = event.data
  if (!message?.type) return

  if (message.type === 'storeRaw') {
    const { filePath, data } = message.payload || {}
    if (!filePath) return
    rawCache.clear()
    if (!data) {
      return
    }
    rawCache.set(filePath, data)
    return
  }

  if (message.type === 'clearQueue') {
    queueToken += 1
    renderQueue = []
    if (renderTimer) {
      clearTimeout(renderTimer)
      renderTimer = null
    }
    return
  }

  if (message.type === 'renderBatch') {
    queueToken += 1
    renderQueue = dedupeRequests(
      Array.isArray(message.payload?.requests) ? message.payload.requests : []
    )
    if (!renderQueue.length) {
      if (renderTimer) {
        clearTimeout(renderTimer)
        renderTimer = null
      }
      return
    }
    scheduleQueueProcessing(queueToken)
  }
}
