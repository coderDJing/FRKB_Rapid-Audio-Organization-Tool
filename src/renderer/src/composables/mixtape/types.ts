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
  // 调性（如 8A / C#m）
  key?: string
  // 当前目标 BPM（可能由吸附对齐自动改写）
  bpm?: number
  // 首次加载时的原始 BPM，用于计算变速比率
  originalBpm?: number
  // 是否启用 Master Tempo（保持调性）
  masterTempo?: boolean
  // 全局时间线起点（秒）
  startSec?: number
  // 首拍偏移（毫秒）
  firstBeatMs?: number
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
  sourceDurationSeconds: number
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
