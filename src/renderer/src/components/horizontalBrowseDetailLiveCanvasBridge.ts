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
    waveformCanvases: Array<HTMLCanvasElement | null>,
    overlayCanvases: Array<HTMLCanvasElement | null>
  ) => {
    const validWaveformCanvases = waveformCanvases.filter(
      (canvas): canvas is HTMLCanvasElement =>
        !!canvas && typeof canvas.transferControlToOffscreen === 'function'
    )
    const validOverlayCanvases = overlayCanvases.filter(
      (canvas): canvas is HTMLCanvasElement =>
        !!canvas && typeof canvas.transferControlToOffscreen === 'function'
    )
    if (
      attached ||
      validWaveformCanvases.length === 0 ||
      validWaveformCanvases.length !== validOverlayCanvases.length
    ) {
      return false
    }
    const offscreenWaveformCanvases = validWaveformCanvases.map((canvas) =>
      canvas.transferControlToOffscreen()
    )
    const offscreenOverlayCanvases = validOverlayCanvases.map((canvas) =>
      canvas.transferControlToOffscreen()
    )
    postMessage(
      {
        type: 'attachCanvas',
        payload: {
          waveformCanvas: offscreenWaveformCanvases[0],
          overlayCanvas: offscreenOverlayCanvases[0],
          waveformCanvases: offscreenWaveformCanvases,
          overlayCanvases: offscreenOverlayCanvases
        }
      },
      [...offscreenWaveformCanvases, ...offscreenOverlayCanvases]
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
    postMessage({
      type: 'replaceRaw',
      payload: {
        data
      }
    })
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
