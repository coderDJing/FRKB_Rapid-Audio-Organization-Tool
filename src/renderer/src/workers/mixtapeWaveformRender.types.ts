export type StemWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft: Uint8Array
  peakRight: Uint8Array
}

export type StemWaveformData = {
  sampleRate: number
  duration: number
  step: number
  all: StemWaveformBand
}

export type WaveformStemId = 'vocal' | 'inst' | 'bass' | 'drums'

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

export type SerializedWorkerTrackTempoSnapshot = {
  signature: string
  durationSec: number
  baseDurationSec: number
  sourceDurationSec: number
  baseBpm: number
  gridSourceBpm: number
  originalBpm: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset: number
  mappingMode?: 'tempoEnvelope' | 'masterGrid'
  trackStartSec?: number
  masterGridFallbackBpm?: number
  masterGridPhaseOffsetSec?: number
  masterGridPoints?: Array<{ sec: number; bpm: number }>
  loopSegments?: Array<{ startSec: number; endSec: number; repeatCount: number }>
  loopSegment?: { startSec: number; endSec: number; repeatCount: number }
  controlPoints: Array<{ sec: number; bpm: number; sourceSec?: number; allowOffGrid?: boolean }>
}

export type SerializedWorkerVisibleGridLine = {
  sec: number
  sourceSec: number
  level: 'bar' | 'beat4' | 'beat'
}

export type RenderTilePayload = {
  cacheKey: string
  filePath: string
  stemId: WaveformStemId
  zoom: number
  tileIndex: number
  tileStart: number
  tileWidth: number
  trackWidth: number
  durationSeconds: number
  tempoSnapshot: SerializedWorkerTrackTempoSnapshot
  laneHeight: number
  pixelRatio: number
}

export type PreRenderPayload = {
  tasks: RenderTilePayload[]
}

export type RenderFrameTrack = {
  id: string
  filePath: string
  waveformFilePath?: string
  waveformStemId: WaveformStemId
  durationSeconds: number
  timelineDurationSeconds: number
  trackWidth: number
  startSec: number
  startX: number
  laneIndex: number
  laneOffsetY?: number
  laneHeight?: number
  tempoSnapshot: SerializedWorkerTrackTempoSnapshot
  visibleGridLines: SerializedWorkerVisibleGridLine[]
  visibleGridSignature: string
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
  trackContentTop: number
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
