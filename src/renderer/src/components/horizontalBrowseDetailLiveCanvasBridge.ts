import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createHorizontalBrowseDetailLiveCanvasWorker } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.workerClient'
import type {
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

export const createHorizontalBrowseDetailLiveCanvasBridge = (
  options: CreateHorizontalBrowseDetailLiveCanvasBridgeOptions
) => {
  const worker = createHorizontalBrowseDetailLiveCanvasWorker()
  let attached = false

  const handleWorkerMessage = (
    event: MessageEvent<HorizontalBrowseDetailLiveCanvasWorkerOutgoing>
  ) => {
    const message = event.data
    if (message?.type === 'rendered') {
      options.onRendered(message.payload)
      return
    }
    if (message?.type === 'presentation') {
      options.onPresentation(message.payload)
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
    replaceRaw,
    render,
    dispose
  }
}
