const MIXXX_WAVEFORM_CACHE_VERSION = 2
const MIXXX_MIXTAPE_WAVEFORM_CACHE_VERSION = 2
const MIXXX_WAVEFORM_BANDS = ['low', 'mid', 'high', 'all'] as const

export type MixxxWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft: Uint8Array
  peakRight: Uint8Array
}

export type MixxxWaveformData = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<(typeof MIXXX_WAVEFORM_BANDS)[number], MixxxWaveformBand>
}
export function getMixxxWaveformByteLength(frames: number): number {
  return frames * 16
}

export function encodeMixxxWaveformData(
  data: MixxxWaveformData
): { frames: number; payload: Buffer } | null {
  const low = data.bands.low
  const mid = data.bands.mid
  const high = data.bands.high
  const all = data.bands.all
  const frames = low.left.length
  if (!frames) return null
  if (
    low.right.length !== frames ||
    low.peakLeft.length !== frames ||
    low.peakRight.length !== frames ||
    mid.left.length !== frames ||
    mid.right.length !== frames ||
    mid.peakLeft.length !== frames ||
    mid.peakRight.length !== frames ||
    high.left.length !== frames ||
    high.right.length !== frames ||
    high.peakLeft.length !== frames ||
    high.peakRight.length !== frames ||
    all.left.length !== frames ||
    all.right.length !== frames ||
    all.peakLeft.length !== frames ||
    all.peakRight.length !== frames
  ) {
    return null
  }

  const payload = Buffer.concat([
    Buffer.from(low.left),
    Buffer.from(low.right),
    Buffer.from(low.peakLeft),
    Buffer.from(low.peakRight),
    Buffer.from(mid.left),
    Buffer.from(mid.right),
    Buffer.from(mid.peakLeft),
    Buffer.from(mid.peakRight),
    Buffer.from(high.left),
    Buffer.from(high.right),
    Buffer.from(high.peakLeft),
    Buffer.from(high.peakRight),
    Buffer.from(all.left),
    Buffer.from(all.right),
    Buffer.from(all.peakLeft),
    Buffer.from(all.peakRight)
  ])

  return { frames, payload }
}

export function decodeMixxxWaveformData(
  meta: { sampleRate: number; step: number; duration: number; frames: number },
  payload: Buffer
): MixxxWaveformData | null {
  if (!meta || !payload) return null
  if (!meta.frames || meta.frames <= 0) return null
  const expected = getMixxxWaveformByteLength(meta.frames)
  if (payload.length < expected) return null

  let offset = 0
  const readArray = () => {
    const slice = payload.subarray(offset, offset + meta.frames)
    offset += meta.frames
    return slice
  }

  const low = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }
  const mid = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }
  const high = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }
  const all = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }

  return {
    duration: meta.duration,
    sampleRate: meta.sampleRate,
    step: meta.step,
    bands: { low, mid, high, all }
  }
}

export { MIXXX_WAVEFORM_CACHE_VERSION, MIXXX_MIXTAPE_WAVEFORM_CACHE_VERSION }
