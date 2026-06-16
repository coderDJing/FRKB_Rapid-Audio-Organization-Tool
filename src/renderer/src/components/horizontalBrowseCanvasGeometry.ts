const STABLE_MAX_RENDER_SCALED_WIDTH = 30000

export const resolvePixelSnappedCssSize = (value: number, pixelRatio: number) => {
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 1
  return Math.max(1, Math.ceil(numeric * safePixelRatio) / safePixelRatio)
}

export const resolveHorizontalBrowseStableOverscanCssPx = (width: number, pixelRatio: number) => {
  const safeWidth = Math.max(1, Number(width) || 1)
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const maxRenderWidth = Math.max(safeWidth, STABLE_MAX_RENDER_SCALED_WIDTH / safePixelRatio)
  const maxOverscan = Math.max(0, (maxRenderWidth - safeWidth) * 0.5)
  return Math.min(Math.max(256, safeWidth * 3), maxOverscan)
}

export const setHorizontalBrowseCanvasGeometry = (
  canvas: HTMLCanvasElement | null,
  left: number,
  top: number,
  width: number,
  height: number
) => {
  if (!canvas) return
  Object.assign(canvas.style, {
    left: `${left}px`,
    top: `${top}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${width}px`,
    height: `${height}px`
  })
}

export const setHorizontalBrowseLiveCanvasGeometry = (
  waveformCanvas: HTMLCanvasElement | null,
  gridCanvas: HTMLCanvasElement | null,
  overlayCanvas: HTMLCanvasElement | null,
  left: number,
  width: number,
  height: number,
  overlayHeight: number
) => {
  setHorizontalBrowseCanvasGeometry(waveformCanvas, left, 0, width, height)
  setHorizontalBrowseCanvasGeometry(gridCanvas, left, 0, width, height)
  setHorizontalBrowseCanvasGeometry(overlayCanvas, left, 0, width, overlayHeight)
}

export const applyHorizontalBrowseCanvasPresentationOffset = (
  waveformCanvas: HTMLCanvasElement | null,
  overlayCanvas: HTMLCanvasElement | null,
  offsetCssPx: number,
  applyOverlayOffset: boolean
) => {
  if (!waveformCanvas) return
  const clearTransform = (canvas: HTMLCanvasElement | null) =>
    canvas?.style.removeProperty('transform')
  const offset = Number(offsetCssPx) || 0
  if (Math.abs(offset) <= 0.001) {
    clearTransform(waveformCanvas)
    clearTransform(overlayCanvas)
    return
  }
  const transform = `translate3d(${offset}px, 0, 0)`
  waveformCanvas.style.transform = transform
  if (applyOverlayOffset) {
    overlayCanvas?.style.setProperty('transform', transform)
  } else {
    clearTransform(overlayCanvas)
  }
}
