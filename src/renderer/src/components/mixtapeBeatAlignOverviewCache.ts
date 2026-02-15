import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { drawMixxxRgbWaveform } from '@renderer/composables/mixtape/waveformDraw'
import { resolveRawWaveformLevel } from '@renderer/composables/mixtape/waveformPyramid'
import type { RawWaveformData, RawWaveformLevel } from '@renderer/composables/mixtape/types'

type BuildBeatAlignOverviewCacheParams = {
  wrap: HTMLDivElement | null
  cacheCanvas: HTMLCanvasElement | null
  mixxxData: MixxxWaveformData | null
  rawData: RawWaveformData | null
  rawPyramidMap: Map<string, RawWaveformLevel[]>
  rawKey: string
  maxRenderColumns: number
  isHalfWaveform: boolean
  waveformVerticalPadding: number
  leadingPadSec: number
}

export const rebuildBeatAlignOverviewCache = (
  params: BuildBeatAlignOverviewCacheParams
): HTMLCanvasElement | null => {
  const {
    wrap,
    cacheCanvas,
    mixxxData,
    rawData,
    rawPyramidMap,
    rawKey,
    maxRenderColumns,
    isHalfWaveform,
    waveformVerticalPadding,
    leadingPadSec
  } = params
  if (!wrap || !mixxxData) return null

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

  const duration = Number(mixxxData.duration) || 0
  const safeLeadingPadSec = Number.isFinite(leadingPadSec) && leadingPadSec > 0 ? leadingPadSec : 0
  const virtualSpanSec = Math.max(0.0001, duration + safeLeadingPadSec)
  const leadingPadPx = (safeLeadingPadSec / virtualSpanSec) * renderWidth
  const contentWidth = Math.max(1, renderWidth - leadingPadPx)
  const rawSpan = Math.max(0, duration)
  const rawSamplesPerPixel =
    rawData && rawSpan > 0 ? (rawData.rate * rawSpan) / Math.max(1, contentWidth * dpr) : 0
  const resolvedRaw = resolveRawWaveformLevel(rawPyramidMap, rawKey, rawData, rawSamplesPerPixel)

  const verticalPadding = Math.max(0, Math.min(Math.floor(height / 3), waveformVerticalPadding))
  const drawHeight = Math.max(1, height - verticalPadding * 2)
  cacheCtx.save()
  cacheCtx.translate(leadingPadPx, verticalPadding)
  drawMixxxRgbWaveform(cacheCtx, contentWidth, drawHeight, mixxxData, isHalfWaveform, {
    startFrame: 0,
    endFrame: frameCount,
    startTime: 0,
    endTime: Math.max(0, duration),
    raw: resolvedRaw
  })
  cacheCtx.restore()

  return nextCanvas
}
