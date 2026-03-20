export type CanvasScaleMetrics = {
  cssWidth: number
  cssHeight: number
  pixelRatio: number
  scaledWidth: number
  scaledHeight: number
  scaleX: number
  scaleY: number
}

type CanvasLike = {
  width: number
  height: number
}

const clampPixelRatio = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return 1
  return value
}

export const resolveCanvasScaleMetrics = (
  width: number,
  height: number,
  pixelRatio: number
): CanvasScaleMetrics => {
  const cssWidth = Math.max(1, Math.floor(Number(width) || 0))
  const cssHeight = Math.max(1, Math.floor(Number(height) || 0))
  const safePixelRatio = clampPixelRatio(pixelRatio)
  const scaledWidth = Math.max(1, Math.round(cssWidth * safePixelRatio))
  const scaledHeight = Math.max(1, Math.round(cssHeight * safePixelRatio))
  return {
    cssWidth,
    cssHeight,
    pixelRatio: safePixelRatio,
    scaledWidth,
    scaledHeight,
    scaleX: scaledWidth / cssWidth,
    scaleY: scaledHeight / cssHeight
  }
}

export const resizeCanvasWithScaleMetrics = (
  canvas: CanvasLike,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  pixelRatio: number
) => {
  const metrics = resolveCanvasScaleMetrics(width, height, pixelRatio)
  if (canvas.width !== metrics.scaledWidth) {
    canvas.width = metrics.scaledWidth
  }
  if (canvas.height !== metrics.scaledHeight) {
    canvas.height = metrics.scaledHeight
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
  ctx.setTransform(metrics.scaleX, 0, 0, metrics.scaleY, 0, 0)
  return metrics
}
