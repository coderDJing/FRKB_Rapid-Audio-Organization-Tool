import type { WaveformGlobalOverviewData } from '@shared/waveformSurfaceCache'
import { drawCompactVisualWaveform } from '@renderer/components/compactVisualWaveformRenderer'

type BuildBeatAlignOverviewCacheParams = {
  wrap: HTMLDivElement | null
  cacheCanvas: HTMLCanvasElement | null
  compactData?: WaveformGlobalOverviewData | null
  maxRenderColumns: number
  waveformVerticalPadding: number
  leadingPadSec: number
  trailingPadSec?: number
  timeBasisOffsetMs?: number
}

export const rebuildBeatAlignOverviewCache = (
  params: BuildBeatAlignOverviewCacheParams
): HTMLCanvasElement | null => {
  const {
    wrap,
    cacheCanvas,
    compactData,
    maxRenderColumns,
    waveformVerticalPadding,
    leadingPadSec,
    trailingPadSec,
    timeBasisOffsetMs
  } = params
  if (!wrap || !compactData) return null

  const width = Math.max(1, Math.floor(wrap.clientWidth))
  const height = Math.max(1, Math.floor(wrap.clientHeight))
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const renderWidth = Math.max(160, Math.min(width, maxRenderColumns))
  const renderPixelWidth = Math.max(1, Math.floor(renderWidth * dpr))
  const renderPixelHeight = Math.max(1, Math.floor(height * dpr))

  const nextCanvas = cacheCanvas || document.createElement('canvas')
  if (nextCanvas.width !== renderPixelWidth || nextCanvas.height !== renderPixelHeight) {
    nextCanvas.width = renderPixelWidth
    nextCanvas.height = renderPixelHeight
  }

  const cacheCtx = nextCanvas.getContext('2d')
  if (!cacheCtx) return nextCanvas

  cacheCtx.setTransform(1, 0, 0, 1, 0, 0)
  cacheCtx.clearRect(0, 0, renderPixelWidth, renderPixelHeight)
  cacheCtx.scale(dpr, dpr)

  const duration = Number(compactData.duration || 0) || 0
  const safeLeadingPadSec = Number.isFinite(leadingPadSec) && leadingPadSec > 0 ? leadingPadSec : 0
  const safeTrailingPadSec =
    Number.isFinite(trailingPadSec) && Number(trailingPadSec) > 0 ? Number(trailingPadSec) : 0
  const virtualSpanSec = Math.max(0.0001, duration + safeLeadingPadSec + safeTrailingPadSec)
  const leadingPadPx = (safeLeadingPadSec / virtualSpanSec) * renderWidth
  const trailingPadPx = (safeTrailingPadSec / virtualSpanSec) * renderWidth
  const contentWidth = Math.max(1, renderWidth - leadingPadPx - trailingPadPx)

  const verticalPadding = Math.max(0, Math.min(Math.floor(height / 3), waveformVerticalPadding))
  const drawHeight = Math.max(1, height - verticalPadding * 2)
  cacheCtx.save()
  cacheCtx.translate(leadingPadPx, verticalPadding)
  drawCompactVisualWaveform(cacheCtx, {
    width: Math.max(1, Math.floor(contentWidth)),
    height: drawHeight,
    data: compactData,
    timeBasisOffsetMs,
    rangeStartSec: 0,
    rangeDurationSec: Math.max(0.0001, duration),
    showDetailHighlights: false,
    showCenterLine: false,
    waveformLayout: 'full'
  })
  cacheCtx.restore()

  return nextCanvas
}
