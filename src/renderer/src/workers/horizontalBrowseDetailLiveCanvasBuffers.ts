import { createHorizontalBrowseDetailLiveCanvasOverlayRenderer } from './horizontalBrowseDetailLiveCanvasOverlay'

type LiveCanvasOverlayRenderer = ReturnType<
  typeof createHorizontalBrowseDetailLiveCanvasOverlayRenderer
>

export type HorizontalBrowseDetailLiveCanvasBuffer = {
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  overlayRenderer: LiveCanvasOverlayRenderer
}

const normalizeBufferIndex = (value: unknown, fallback: number) => {
  const numeric = Math.floor(Number(value))
  return numeric === 0 || numeric === 1 ? numeric : fallback
}

export const createHorizontalBrowseDetailLiveCanvasBufferManager = () => {
  let buffers: HorizontalBrowseDetailLiveCanvasBuffer[] = []

  const attach = (waveformCanvases: OffscreenCanvas[], overlayCanvases: OffscreenCanvas[]) => {
    buffers = waveformCanvases.flatMap((canvas, index) => {
      const overlayCanvas = overlayCanvases[index]
      const ctx = canvas.getContext('2d')
      if (!ctx || !overlayCanvas) return []
      const overlayRenderer = createHorizontalBrowseDetailLiveCanvasOverlayRenderer()
      overlayRenderer.attach(overlayCanvas)
      return [{ canvas, ctx, overlayRenderer }]
    })
  }

  const resolve = (index: unknown) => {
    if (buffers.length === 0) return null
    return buffers[normalizeBufferIndex(index, 0)] ?? buffers[0] ?? null
  }

  const clearAll = () => {
    for (const buffer of buffers) {
      buffer.ctx.setTransform(1, 0, 0, 1, 0, 0)
      buffer.ctx.clearRect(0, 0, buffer.canvas.width, buffer.canvas.height)
      buffer.overlayRenderer.clear()
    }
  }

  return {
    attach,
    resolve,
    clearAll
  }
}
