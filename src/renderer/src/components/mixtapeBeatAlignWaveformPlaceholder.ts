import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'

export const createRawPlaceholderMixxxData = (rawData: RawWaveformData): MixxxWaveformData => {
  const low = 128
  const mid = 188
  const high = 232
  const all = 220
  const single = (value: number) => new Uint8Array([value])
  return {
    duration: Math.max(0, Number(rawData.duration) || 0),
    sampleRate: Math.max(1, Number(rawData.sampleRate) || 1),
    step: Math.max(
      1,
      Math.floor((Number(rawData.sampleRate) || 1) / Math.max(1, Number(rawData.rate) || 1))
    ),
    bands: {
      low: { left: single(low), right: single(low) },
      mid: { left: single(mid), right: single(mid) },
      high: { left: single(high), right: single(high) },
      all: { left: single(all), right: single(all) }
    }
  }
}
