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
  maxRight: new Float32Array(value.maxRight)
})

const collectTransferableBuffers = (arrays: Float32Array[]) => {
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
  maxRight: new Float32Array(value.maxRight)
})

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

  const resetRaw = (meta: HorizontalBrowseDetailLiveCanvasRawMeta, retainCurrent = true) => {
    postMessage({ type: 'resetRaw', payload: { ...meta, retainCurrent } })
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
        payload.maxRight
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
            cloned.maxRight
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
    resetRaw,
    ensureRawCapacity,
    applyRawChunk,
    replaceRaw,
    updateRawMeta,
    render,
    dispose
  }
}
