export const resolvePixelSnappedCssSize = (value: number, pixelRatio: number) => {
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 1
  return Math.max(1, Math.ceil(numeric * safePixelRatio) / safePixelRatio)
}
