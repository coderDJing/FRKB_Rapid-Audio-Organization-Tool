import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { drawBeatGridWaveform } from '@renderer/components/beatGridWaveformRenderer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import { drawCompactVisualWaveform } from '@renderer/components/compactVisualWaveformRenderer'

type BuildBeatAlignOverviewCacheParams = {
  wrap: HTMLDivElement | null
  cacheCanvas: HTMLCanvasElement | null
  mixxxData: MixxxWaveformData | null
  rawData: RawWaveformData | null
  compactData?: CompactVisualWaveformData | null
  maxRenderColumns: number
  maxSamplesPerPixel: number
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
    mixxxData,
    rawData,
    compactData,
    maxRenderColumns,
    maxSamplesPerPixel,
    waveformVerticalPadding,
    leadingPadSec,
    trailingPadSec,
    timeBasisOffsetMs
  } = params
  if (!wrap || (!compactData && (!mixxxData || !rawData))) return null

  if (!compactData && mixxxData) {
    const low = mixxxData.bands?.low
    const mid = mixxxData.bands?.mid
    const high = mixxxData.bands?.high
    const all = mixxxData.bands?.all
    if (!low || !mid || !high || !all) return cacheCanvas

    const frameCount = Math.min(
      low.left.length,
      low.right.length,
      mid.left.length,
      mid.right.length,
      high.left.length,
      high.right.length,
      all.left.length,
      all.right.length
    )
    if (!frameCount) return cacheCanvas
  }

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

  const duration = Number(compactData?.duration || mixxxData?.duration || rawData?.duration) || 0
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
  if (compactData) {
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
  } else {
    drawBeatGridWaveform(cacheCtx, {
      width: Math.max(1, Math.floor(contentWidth)),
      height: drawHeight,
      bpm: 0,
      firstBeatMs: 0,
      barBeatOffset: 0,
      timeBasisOffsetMs,
      rangeStartSec: 0,
      rangeDurationSec: Math.max(0.0001, duration),
      mixxxData,
      rawData,
      showBackground: false,
      maxSamplesPerPixel,
      showDetailHighlights: false,
      showCenterLine: false,
      waveformRenderStyle: 'raw-curve'
    })
  }
  cacheCtx.restore()

  return nextCanvas
}
