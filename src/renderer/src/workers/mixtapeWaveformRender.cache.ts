export const resolveFrameBufferMultiplier = (zoom: number, mixTapeBufferMultiplier: number) => {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1
  if (safeZoom >= 6) return 4
  if (safeZoom >= 3) return 3.5
  return mixTapeBufferMultiplier
}

export const resolveGridDownbeatWidth = (params: {
  zoom: number
  rawWaveformMinZoom: number
  gridDownbeatWidthMin: number
  gridDownbeatWidthMax: number
  gridDownbeatWidthMaxZoom: number
}) => {
  const safeZoom = Number.isFinite(params.zoom) ? params.zoom : 1
  const minZoom = params.rawWaveformMinZoom
  const maxZoom = params.gridDownbeatWidthMaxZoom
  if (safeZoom <= minZoom) return params.gridDownbeatWidthMin
  if (safeZoom >= maxZoom) return params.gridDownbeatWidthMax
  const ratio = (safeZoom - minZoom) / Math.max(0.0001, maxZoom - minZoom)
  return (
    params.gridDownbeatWidthMin +
    (params.gridDownbeatWidthMax - params.gridDownbeatWidthMin) * ratio
  )
}

export const buildWaveformTileCacheKey = (params: {
  filePath: string
  stemId: string
  tileIndex: number
  zoomValue: number
  width: number
  height: number
  pixelRatio: number
  signature?: string
  waveformHeightScale: number
}) => {
  const zoomKey = Math.round(params.zoomValue * 1000)
  const ratioKey = Math.round(params.pixelRatio * 100)
  const waveformHeightScaleKey = Math.round(params.waveformHeightScale * 1000)
  const normalizedTimeMapSignature =
    typeof params.signature === 'string' && params.signature ? params.signature : 'default'
  return `${params.filePath}::${params.stemId}::${params.tileIndex}::${zoomKey}::${params.width}x${params.height}@${ratioKey}::h${waveformHeightScaleKey}::tm:${normalizedTimeMapSignature}`
}
