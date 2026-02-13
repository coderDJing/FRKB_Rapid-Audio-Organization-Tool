import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

export type MixtapeOpenPayload = {
  playlistId?: string
  playlistPath?: string
  playlistName?: string
}

export type MixtapeRawItem = {
  id?: string
  filePath?: string
  mixOrder?: number
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  infoJson?: string | null
}

export type MixtapeTrack = {
  id: string
  mixOrder: number
  title: string
  artist: string
  duration: string
  filePath: string
  originPath: string
  originPlaylistUuid?: string | null
  bpm?: number
}

export type MinMaxSample = {
  min: number
  max: number
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

export type WaveformTile = {
  index: number
  start: number
  width: number
}

export type WaveformRenderContext = {
  track: MixtapeTrack
  trackWidth: number
  durationSeconds: number
  data: MixxxWaveformData | null
  frameCount: number
  rawData: RawWaveformData | null
  renderZoom: number
  renderPxPerSec: number
  laneHeight: number
}

export type WaveformPreRenderTask = {
  ctx: WaveformRenderContext
  tile: WaveformTile
  cacheKey: string
}

export type TimelineTrackLayout = {
  track: MixtapeTrack
  laneIndex: number
  startX: number
  width: number
}

export type TimelineRenderTrack = {
  id: string
  filePath: string
  durationSeconds: number
  trackWidth: number
  startX: number
  laneIndex: number
  bpm: number
  firstBeatMs: number
}

export type TimelineRenderPayload = {
  width: number
  height: number
  pixelRatio: number
  showGridLines: boolean
  allowTileBuild: boolean
  startX: number
  startY: number
  bufferId: string
  zoom: number
  laneHeight: number
  laneGap: number
  lanePaddingTop: number
  renderPxPerSec: number
  renderVersion: number
  tracks: TimelineRenderTrack[]
}

export type TimelineLayoutSnapshot = {
  layout: TimelineTrackLayout[]
  totalWidth: number
  startOffsets: number[]
  endOffsets: number[]
}
