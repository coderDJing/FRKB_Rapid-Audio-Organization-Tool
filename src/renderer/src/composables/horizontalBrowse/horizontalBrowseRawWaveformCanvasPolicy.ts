import type { HorizontalBrowseWaveformRenderStyle } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasTypes'

const ATTACK_SAFE_RAW_PEAK_MAX_SEC_PER_RENDER_PIXEL = 0.002

export const shouldUseAttackSafeRawPeaks = (
  rangeDurationSec: number,
  cssWidth: number,
  pixelRatio: number,
  waveformRenderStyle: HorizontalBrowseWaveformRenderStyle
) => {
  if (waveformRenderStyle !== 'columns') return false
  const safeRangeDurationSec = Number(rangeDurationSec)
  if (!Number.isFinite(safeRangeDurationSec) || safeRangeDurationSec <= 0) return false
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const renderPixels = Math.max(1, Math.floor(Math.max(1, cssWidth) * safePixelRatio))
  const secondsPerRenderPixel = safeRangeDurationSec / renderPixels
  return (
    Number.isFinite(secondsPerRenderPixel) &&
    secondsPerRenderPixel > 0 &&
    secondsPerRenderPixel <= ATTACK_SAFE_RAW_PEAK_MAX_SEC_PER_RENDER_PIXEL
  )
}
