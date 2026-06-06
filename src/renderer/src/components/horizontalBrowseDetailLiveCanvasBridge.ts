import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createHorizontalBrowseDetailLiveCanvasWorker } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.workerClient'
import type {
  HorizontalBrowseDetailLiveCanvasRawChunk,
  HorizontalBrowseDetailLiveCanvasRawMeta,
  HorizontalBrowseDetailLiveCanvasRenderRequest,
  HorizontalBrowseDetailLiveCanvasWorkerIncoming,
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing
} from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'

type CreateHorizontalBrowseDetailLiveCanvasBridgeOptions = {
  onRendered: (
    payload: Extract<
      HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
      { type: 'rendered' }
    >['payload']
  ) => void
  onPresentation: (
    payload: Extract<
      HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
      { type: 'presentation' }
    >['payload']
  ) => void
}

const cloneRawWaveformData = (value: RawWaveformData): RawWaveformData => ({
  duration: Number(value.duration) || 0,
  sampleRate: Number(value.sampleRate) || 0,
  rate: Number(value.rate) || 0,
  frames: Math.max(0, Number(value.frames) || 0),
  startSec: Math.max(0, Number(value.startSec) || 0),
  loadedFrames: Math.max(0, Number(value.loadedFrames ?? value.frames) || 0),
  minLeft: new Float32Array(value.minLeft),
  maxLeft: new Float32Array(value.maxLeft),
  minRight: new Float32Array(value.minRight),
  maxRight: new Float32Array(value.maxRight),
  meanLeft: value.meanLeft ? new Float32Array(value.meanLeft) : undefined,
  meanRight: value.meanRight ? new Float32Array(value.meanRight) : undefined,
  rmsLeft: value.rmsLeft ? new Float32Array(value.rmsLeft) : undefined,
  rmsRight: value.rmsRight ? new Float32Array(value.rmsRight) : undefined,
  compactColorIndex: value.compactColorIndex ? new Uint8Array(value.compactColorIndex) : undefined,
  compactColorLow: value.compactColorLow ? new Uint8Array(value.compactColorLow) : undefined,
  compactColorMid: value.compactColorMid ? new Uint8Array(value.compactColorMid) : undefined,
  compactColorHigh: value.compactColorHigh ? new Uint8Array(value.compactColorHigh) : undefined,
  compactColorRed: value.compactColorRed ? new Uint8Array(value.compactColorRed) : undefined,
  compactColorGreen: value.compactColorGreen ? new Uint8Array(value.compactColorGreen) : undefined,
  compactColorBlue: value.compactColorBlue ? new Uint8Array(value.compactColorBlue) : undefined,
  compactColorRateDivisor: value.compactColorRateDivisor,
  compactColorStartFrame: value.compactColorStartFrame
})

const collectTransferableBuffers = (arrays: Array<Float32Array | Uint8Array>) => {
  const buffers = new Set<ArrayBuffer>()
  for (const array of arrays) {
    const buffer = array.buffer
    if (buffer instanceof ArrayBuffer) {
      buffers.add(buffer)
    }
  }
  return [...buffers]
}

const cloneRawChunk = (
  value: HorizontalBrowseDetailLiveCanvasRawChunk
): HorizontalBrowseDetailLiveCanvasRawChunk => ({
  duration: value.duration,
  sampleRate: value.sampleRate,
  rate: value.rate,
  frames: value.frames,
  startSec: value.startSec,
  loadedFrames: value.loadedFrames,
  startFrame: value.startFrame,
  chunkFrames: value.chunkFrames,
  minLeft: new Float32Array(value.minLeft),
  maxLeft: new Float32Array(value.maxLeft),
  minRight: new Float32Array(value.minRight),
  maxRight: new Float32Array(value.maxRight),
  meanLeft: value.meanLeft ? new Float32Array(value.meanLeft) : undefined,
  meanRight: value.meanRight ? new Float32Array(value.meanRight) : undefined,
  rmsLeft: value.rmsLeft ? new Float32Array(value.rmsLeft) : undefined,
  rmsRight: value.rmsRight ? new Float32Array(value.rmsRight) : undefined
})

export const createHorizontalBrowseDetailLiveCanvasBridge = (
  options: CreateHorizontalBrowseDetailLiveCanvasBridgeOptions
) => {
  const worker = createHorizontalBrowseDetailLiveCanvasWorker()
  let attached = false
  let lastRenderedReady: boolean | null = null
  const writeWorkerDebugLog = (
    event: string,
    details?: Record<string, number | string | boolean | null>
  ) => {
    const detailText = details ? ` ${JSON.stringify(details)}` : ''
    window.electron?.ipcRenderer?.send?.('outputLog', {
      level: 'info',
      scope: 'main-window',
      source: 'hb-live-canvas-worker',
      message: `[HB-WAVEFORM] ${event}${detailText}`
    })
  }

  const handleWorkerMessage = (
    event: MessageEvent<HorizontalBrowseDetailLiveCanvasWorkerOutgoing>
  ) => {
    const message = event.data
    if (message?.type === 'rendered') {
      if (message.payload.ready !== lastRenderedReady || !message.payload.ready) {
        writeWorkerDebugLog(
          message.payload.ready ? 'worker-rendered-ready' : 'worker-render-miss',
          {
            renderToken: message.payload.renderToken,
            rangeStartSec: message.payload.rangeStartSec,
            rangeDurationSec: message.payload.rangeDurationSec
          }
        )
      }
      lastRenderedReady = message.payload.ready
      options.onRendered(message.payload)
      return
    }
    if (message?.type === 'presentation') {
      options.onPresentation(message.payload)
      return
    }
    if (message?.type === 'debug') {
      writeWorkerDebugLog(message.payload.event, message.payload.details)
      return
    }
  }

  worker.addEventListener('message', handleWorkerMessage)
  worker.addEventListener('error', (event) => {
    const errorEvent = event as ErrorEvent
    console.error('[horizontal-browse-live-canvas-worker] error', {
      message: errorEvent?.message || 'unknown worker error',
      filename: errorEvent?.filename,
      lineno: errorEvent?.lineno,
      colno: errorEvent?.colno
    })
  })
  worker.addEventListener('messageerror', () => {
    console.error('[horizontal-browse-live-canvas-worker] messageerror')
  })

  const postMessage = (
    message: HorizontalBrowseDetailLiveCanvasWorkerIncoming,
    transfer?: Transferable[]
  ) => {
    if (transfer?.length) {
      worker.postMessage(message, transfer)
      return
    }
    worker.postMessage(message)
  }

  const mount = (
    waveformCanvas: HTMLCanvasElement | null,
    overlayCanvas: HTMLCanvasElement | null
  ) => {
    if (
      attached ||
      !waveformCanvas ||
      !overlayCanvas ||
      typeof waveformCanvas.transferControlToOffscreen !== 'function' ||
      typeof overlayCanvas.transferControlToOffscreen !== 'function'
    ) {
      return false
    }
    const offscreenWaveformCanvas = waveformCanvas.transferControlToOffscreen()
    const offscreenOverlayCanvas = overlayCanvas.transferControlToOffscreen()
    postMessage(
      {
        type: 'attachCanvas',
        payload: {
          waveformCanvas: offscreenWaveformCanvas,
          overlayCanvas: offscreenOverlayCanvas
        }
      },
      [offscreenWaveformCanvas, offscreenOverlayCanvas]
    )
    attached = true
    return true
  }

  const clear = () => {
    postMessage({ type: 'clear' })
  }

  const clearRaw = () => {
    postMessage({ type: 'clearRaw' })
  }

  const stopPlayback = () => {
    postMessage({ type: 'stopPlayback' })
  }

  const resetRaw = (
    meta: HorizontalBrowseDetailLiveCanvasRawMeta,
    retainCurrent = true,
    preferRetainedPlaybackRaw = false
  ) => {
    postMessage({
      type: 'resetRaw',
      payload: { ...meta, retainCurrent, preferRetainedPlaybackRaw }
    })
  }

  const ensureRawCapacity = (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => {
    postMessage({ type: 'ensureRawCapacity', payload: meta })
  }

  const applyRawChunk = (
    chunk: HorizontalBrowseDetailLiveCanvasRawChunk,
    transferOwnership = false
  ) => {
    const payload = transferOwnership ? chunk : cloneRawChunk(chunk)
    postMessage(
      { type: 'applyRawChunk', payload },
      collectTransferableBuffers([
        payload.minLeft,
        payload.maxLeft,
        payload.minRight,
        payload.maxRight,
        ...(payload.meanLeft && payload.meanRight ? [payload.meanLeft, payload.meanRight] : []),
        ...(payload.rmsLeft && payload.rmsRight ? [payload.rmsLeft, payload.rmsRight] : [])
      ])
    )
  }

  const replaceRaw = (data: RawWaveformData | null) => {
    const cloned = data ? cloneRawWaveformData(data) : null
    postMessage(
      {
        type: 'replaceRaw',
        payload: {
          data: cloned
        }
      },
      cloned
        ? collectTransferableBuffers([
            cloned.minLeft,
            cloned.maxLeft,
            cloned.minRight,
            cloned.maxRight,
            ...(cloned.meanLeft && cloned.meanRight ? [cloned.meanLeft, cloned.meanRight] : []),
            ...(cloned.rmsLeft && cloned.rmsRight ? [cloned.rmsLeft, cloned.rmsRight] : []),
            ...(cloned.compactColorIndex ? [cloned.compactColorIndex] : []),
            ...(cloned.compactColorLow ? [cloned.compactColorLow] : []),
            ...(cloned.compactColorMid ? [cloned.compactColorMid] : []),
            ...(cloned.compactColorHigh ? [cloned.compactColorHigh] : []),
            ...(cloned.compactColorRed ? [cloned.compactColorRed] : []),
            ...(cloned.compactColorGreen ? [cloned.compactColorGreen] : []),
            ...(cloned.compactColorBlue ? [cloned.compactColorBlue] : [])
          ])
        : undefined
    )
  }

  const updateRawMeta = (meta: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>) => {
    postMessage({ type: 'updateRawMeta', payload: meta })
  }

  const render = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
    postMessage({ type: 'render', payload: request })
  }

  const dispose = () => {
    worker.removeEventListener('message', handleWorkerMessage)
    worker.terminate()
  }

  return {
    mount,
    clear,
    clearRaw,
    stopPlayback,
    resetRaw,
    ensureRawCapacity,
    applyRawChunk,
    replaceRaw,
    updateRawMeta,
    render,
    dispose
  }
}
