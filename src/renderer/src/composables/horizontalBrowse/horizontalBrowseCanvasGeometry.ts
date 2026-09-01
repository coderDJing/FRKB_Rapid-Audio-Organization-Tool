// stable canvas 位图的物理像素宽上限。
// 权衡：越大 → overscan 越大、拖动/滚动越不容易漏出空波形；越小 → promote 时合成面积越小、
// 松手卡顿越轻（实测空档与位图面积正相关：11823px→~105ms，8000px→~100ms，4096px→~66ms）。
// 4096 会让 overscan 小到拖动大波形时漏出空波形（真机确认），故不可用。已恢复为原始值 15360——
// 那是唯一经长期使用验证过滚动/拖动正常的值；8000 亦属未验证的缩水值，同样有漏空波形风险。
// 松手卡顿改由分块/瓦片渲染等方向根治，而非牺牲 overscan。
// 见 drafts/intermittent-bugs/horizontal-browse-live-tempo-release-jitter.md。
const STABLE_MAX_RENDER_SCALED_WIDTH = 15360

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
