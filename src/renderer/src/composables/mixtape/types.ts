import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'

export type StemWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft: Uint8Array
  peakRight: Uint8Array
}

export type StemWaveformData = {
  duration: number
  sampleRate: number
  step: number
  all: StemWaveformBand
}

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

export type MixtapeMixMode = 'eq' | 'stem'
export type MixtapeStemMode = typeof FIXED_MIXTAPE_STEM_MODE
export type MixtapeStemProfile = 'quality'
export type MixtapeStemStatus = 'pending' | 'running' | 'ready' | 'failed'
export type MixtapeWaveformStemId = 'vocal' | 'inst' | 'bass' | 'drums'

export type MixtapeEnvelopeParamId =
  | 'gain'
  | 'high'
  | 'mid'
  | 'low'
  | 'vocal'
  | 'inst'
  | 'bass'
  | 'drums'
  | 'volume'

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
  // 首次加载时的原始调性
  originalKey?: string
  // 当前目标 BPM（可能由吸附对齐自动改写）
  bpm?: number
  // 节拍对齐基准 BPM（原始值或用户手动校正值，不受临时吸附改写影响）
  gridBaseBpm?: number
  // 首次加载时的原始 BPM，用于计算变速比率
  originalBpm?: number
  // 是否启用 Master Tempo（保持调性）
  masterTempo?: boolean
  // 全局时间线起点（秒）
  startSec?: number
  // 兼容旧数据：单段 Loop（轨道内时间）
  loopSegment?: MixtapeTrackLoopSegment
  // 多段 Loop（轨道内时间）
  loopSegments?: MixtapeTrackLoopSegment[]
  // 增益包络线（轨道内时间 -> 线性增益）
  gainEnvelope?: MixtapeGainPoint[]
  // 兼容旧 EQ 三频包络线（迁移期保留）
  highEnvelope?: MixtapeGainPoint[]
  midEnvelope?: MixtapeGainPoint[]
  lowEnvelope?: MixtapeGainPoint[]
  // Vocal Stem 包络线（轨道内时间 -> 线性增益）
  vocalEnvelope?: MixtapeGainPoint[]
  // Inst Stem 包络线（轨道内时间 -> 线性增益）
  instEnvelope?: MixtapeGainPoint[]
  // Bass Stem 包络线（轨道内时间 -> 线性增益）
  bassEnvelope?: MixtapeGainPoint[]
  // Drums Stem 包络线（轨道内时间 -> 线性增益）
  drumsEnvelope?: MixtapeGainPoint[]
  // 音量包络线（轨道内时间 -> 线性增益，最大 1.0）
  volumeEnvelope?: MixtapeGainPoint[]
  // 片段静音区间（轨道内时间，静音遮罩）
  volumeMuteSegments?: MixtapeMuteSegment[]
  // 首拍偏移（毫秒）
  firstBeatMs?: number
  // 大节线相位偏移（以拍为单位，仅改变网格线定义，不改变网格线位置）
  barBeatOffset?: number
  // Stem 素材状态（pending/running/ready/failed）
  stemStatus?: MixtapeStemStatus
  stemError?: string
  stemReadyAt?: number
  stemModel?: string
  stemVersion?: string
  stemVocalPath?: string
  stemInstPath?: string
  stemBassPath?: string
  stemDrumsPath?: string
}

export type MixtapeGainPoint = {
  sec: number
  gain: number
}

export type MixtapeTrackLoopSegment = {
  startSec: number
  endSec: number
  repeatCount: number
}

export type MixtapeBpmPoint = {
  sec: number
  bpm: number
  sourceSec?: number
  allowOffGrid?: boolean
}

export type MixtapeProjectBpmEnvelopeSnapshot = {
  bpmEnvelope: MixtapeBpmPoint[]
  bpmEnvelopeDurationSec: number
  gridPhaseOffsetSec?: number
}

export type SerializedTrackTempoSnapshot = {
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
  masterGridPoints?: MixtapeBpmPoint[]
  loopSegments?: MixtapeTrackLoopSegment[]
  loopSegment?: MixtapeTrackLoopSegment
  controlPoints: MixtapeBpmPoint[]
}

export type SerializedVisibleGridLine = {
  sec: number
  sourceSec: number
  level: 'bar' | 'beat4' | 'beat'
}

export type MixtapeMuteSegment = {
  startSec: number
  endSec: number
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
  startSec?: number
  loadedFrames?: number
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
  waveformFilePath: string
  waveformStemId: MixtapeWaveformStemId
  trackWidth: number
  sourceDurationSeconds: number
  durationSeconds: number
  tempoSnapshot: SerializedTrackTempoSnapshot
  data: StemWaveformData | MixxxWaveformData | null
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
  startSec: number
  startX: number
  width: number
}

export type TimelineRenderTrack = {
  id: string
  filePath: string
  waveformFilePath?: string
  waveformStemId: MixtapeWaveformStemId
  durationSeconds: number
  timelineDurationSeconds: number
  trackWidth: number
  startSec: number
  startX: number
  laneIndex: number
  laneOffsetY?: number
  laneHeight?: number
  tempoSnapshot: SerializedTrackTempoSnapshot
  visibleGridLines: SerializedVisibleGridLine[]
  visibleGridSignature: string
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
  trackContentTop: number
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
