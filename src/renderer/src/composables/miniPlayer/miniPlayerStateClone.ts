import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import type {
  MiniPlayerHostState,
  MiniPlayerPioneerPreviewWaveform
} from '@shared/miniPlayerWindow'
import type { IPioneerPreviewWaveformData, ISongInfo } from 'src/types/globals'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const reviveUint8Array = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (isRecord(value) && Array.isArray(value.data)) {
    return new Uint8Array(value.data as number[])
  }
  return null
}

const cloneSong = (song: ISongInfo | null): ISongInfo | null => {
  if (!song) return null
  try {
    return JSON.parse(JSON.stringify(song)) as ISongInfo
  } catch {
    return { ...song }
  }
}

export const cloneCompactVisualWaveformData = (
  data: CompactVisualWaveformData | null | undefined
): CompactVisualWaveformData | null => {
  if (!data) return null
  const detailPeakTop = reviveUint8Array(data.detailPeakTop)
  const detailPeakBottom = reviveUint8Array(data.detailPeakBottom)
  const detailBody = reviveUint8Array(data.detailBody)
  const colorIndex = reviveUint8Array(data.colorIndex)
  const colorLow = reviveUint8Array(data.colorLow)
  const colorMid = reviveUint8Array(data.colorMid)
  const colorHigh = reviveUint8Array(data.colorHigh)
  const colorRed = reviveUint8Array(data.colorRed)
  const colorGreen = reviveUint8Array(data.colorGreen)
  const colorBlue = reviveUint8Array(data.colorBlue)
  const overviewTop = reviveUint8Array(data.overviewTop)
  const overviewBottom = reviveUint8Array(data.overviewBottom)
  if (
    !detailPeakTop ||
    !detailPeakBottom ||
    !detailBody ||
    !colorIndex ||
    !colorLow ||
    !colorMid ||
    !colorHigh ||
    !colorRed ||
    !colorGreen ||
    !colorBlue ||
    !overviewTop ||
    !overviewBottom
  ) {
    return null
  }
  return {
    version: Number(data.version) || 0,
    parameterVersion: Number(data.parameterVersion) || 0,
    duration: Number(data.duration) || 0,
    sampleRate: Number(data.sampleRate) || 0,
    detailRate: Number(data.detailRate) || 0,
    overviewRate: Number(data.overviewRate) || 0,
    bodyRateDivisor: Number(data.bodyRateDivisor) || 0,
    colorRateDivisor: Number(data.colorRateDivisor) || 0,
    detailPeakTop,
    detailPeakBottom,
    detailBody,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    overviewTop,
    overviewBottom
  }
}

export const clonePioneerPreviewWaveform = (
  data: IPioneerPreviewWaveformData | MiniPlayerPioneerPreviewWaveform | null | undefined
): MiniPlayerPioneerPreviewWaveform | null => {
  if (!data || !Array.isArray(data.columns) || data.columns.length === 0) return null
  try {
    return JSON.parse(JSON.stringify(data)) as MiniPlayerPioneerPreviewWaveform
  } catch {
    return {
      style: data.style === 'rgb' ? 'rgb' : 'blue',
      analyzeFilePath: String(data.analyzeFilePath || ''),
      previewFilePath: String(data.previewFilePath || ''),
      columnCount: Number(data.columnCount) || data.columns.length,
      maxHeight: Number(data.maxHeight) || 1,
      columns: data.columns.map((column) => ({ ...column }))
    }
  }
}

export const cloneMiniPlayerHostState = (state: MiniPlayerHostState): MiniPlayerHostState => ({
  song: cloneSong(state.song),
  playingSongListUUID: String(state.playingSongListUUID || ''),
  isPlaying: !!state.isPlaying,
  currentSeconds: Number(state.currentSeconds) || 0,
  durationSeconds: Number(state.durationSeconds) || 0,
  volume: Number(state.volume) || 0,
  waveformMode: state.waveformMode === 'full' ? 'full' : 'half',
  compactVisualWaveform: cloneCompactVisualWaveformData(state.compactVisualWaveform),
  pioneerPreviewWaveform: clonePioneerPreviewWaveform(state.pioneerPreviewWaveform)
})
