// canvas 参数在分块路径下是块容器 div：它的 left / width / transform 与旧的单张超宽 canvas
// 语义一致，因此这里的视口反解公式对两条路径通用。
type HorizontalBrowseRenderedCanvasViewportOptions = {
  canvas: HTMLElement | null
  rangeStartSec: number | null
  rangeDurationSec: number | null
}

export const resolveHorizontalBrowseCanvasTranslateX = (canvas: HTMLElement | null) => {
  const transform = canvas?.style.transform || ''
  if (!transform || transform === 'none') return 0
  try {
    return Number(new DOMMatrixReadOnly(transform).m41) || 0
  } catch {
    const match = transform.match(/translate3d?\(\s*(-?\d+(?:\.\d+)?)px/i)
    return match ? Number(match[1]) || 0 : 0
  }
}

const resolveHorizontalBrowseCanvasStylePixel = (value: string | undefined) => {
  const numeric = Number.parseFloat(String(value || ''))
  return Number.isFinite(numeric) ? numeric : 0
}

export const resolveHorizontalBrowseRenderedCanvasViewportStartSec = ({
  canvas,
  rangeStartSec,
  rangeDurationSec
}: HorizontalBrowseRenderedCanvasViewportOptions) => {
  if (!canvas || rangeStartSec === null || rangeDurationSec === null || rangeDurationSec <= 0) {
    return null
  }
  const renderWidthCssPx =
    resolveHorizontalBrowseCanvasStylePixel(canvas.style.width) ||
    Math.max(1, canvas.getBoundingClientRect().width)
  if (!Number.isFinite(renderWidthCssPx) || renderWidthCssPx <= 0) return null
  const canvasLeftCssPx = resolveHorizontalBrowseCanvasStylePixel(canvas.style.left)
  const transformCssPx = resolveHorizontalBrowseCanvasTranslateX(canvas)
  const viewportOffsetCssPx = -canvasLeftCssPx - transformCssPx
  return rangeStartSec + (viewportOffsetCssPx * rangeDurationSec) / renderWidthCssPx
}
