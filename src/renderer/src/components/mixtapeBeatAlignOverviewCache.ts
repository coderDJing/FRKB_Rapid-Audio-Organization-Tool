import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { drawBeatAlignRekordboxWaveform } from '@renderer/components/mixtapeBeatAlignWaveform'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type BuildBeatAlignOverviewCacheParams = {
  wrap: HTMLDivElement | null
  cacheCanvas: HTMLCanvasElement | null
  mixxxData: MixxxWaveformData | null
  rawData: RawWaveformData | null
  maxRenderColumns: number
  waveformVerticalPadding: number
  leadingPadSec: number
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
    maxRenderColumns,
    waveformVerticalPadding,
    leadingPadSec,
    timeBasisOffsetMs
  } = params
  // 节拍对齐仅展示精细(raw)波形，raw 未就绪时不渲染概览波形
  if (!wrap || !mixxxData || !rawData) return null

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

  const verticalPadding = Math.max(0, Math.min(Math.floor(height / 3), waveformVerticalPadding))
  const drawHeight = Math.max(1, height - verticalPadding * 2)
  cacheCtx.save()
  cacheCtx.translate(leadingPadPx, verticalPadding)
  drawBeatAlignRekordboxWaveform(cacheCtx, {
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
    maxSamplesPerPixel: 120,
    showDetailHighlights: false,
    showCenterLine: false
  })
  cacheCtx.restore()

  return nextCanvas
}
