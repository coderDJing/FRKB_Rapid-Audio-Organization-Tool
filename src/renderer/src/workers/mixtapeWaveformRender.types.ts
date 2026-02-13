export type MixxxWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft?: Uint8Array
  peakRight?: Uint8Array
}

export type MixxxWaveformData = {
  sampleRate: number
  step: number
  bands: {
    low: MixxxWaveformBand
    mid: MixxxWaveformBand
    high: MixxxWaveformBand
    all: MixxxWaveformBand
  }
}

export type RawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Float32Array
  maxLeft: Float32Array
  minRight: Float32Array
  maxRight: Float32Array
}

export type RawWaveformLevel = RawWaveformData & {
  factor: number
}

export type RenderTilePayload = {
  cacheKey: string
  filePath: string
  zoom: number
  tileIndex: number
  tileStart: number
  tileWidth: number
  trackWidth: number
  durationSeconds: number
  laneHeight: number
  pixelRatio: number
}

export type PreRenderPayload = {
  tasks: RenderTilePayload[]
}

export type RenderFrameTrack = {
  id: string
  filePath: string
  durationSeconds: number
  trackWidth: number
  startX: number
  laneIndex: number
  bpm: number
  firstBeatMs: number
}

export type RenderFramePayload = {
  width: number
  height: number
  pixelRatio: number
  showGridLines?: boolean
  allowTileBuild?: boolean
  startX: number
  startY: number
  bufferId?: string
  zoom: number
  laneHeight: number
  laneGap: number
  lanePaddingTop: number
  renderPxPerSec: number
  renderVersion: number
  tracks: RenderFrameTrack[]
}

export type FrameBufferSlot = {
  key: string
  startX: number
  width: number
  height: number
  canvas: OffscreenCanvas | null
  ctx: OffscreenCanvasRenderingContext2D | null
  texture: WebGLTexture | null
  texWidth: number
  texHeight: number
  fbo: WebGLFramebuffer | null
}
