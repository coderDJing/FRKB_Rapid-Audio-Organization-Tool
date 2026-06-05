import type { RawWaveformData } from '@renderer/composables/mixtape/types'

const decodeRawFloatArray = (input: unknown): Float32Array | null => {
  if (!input) return null
  if (input instanceof Float32Array) return input

  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }

  if (input instanceof ArrayBuffer) {
    return new Float32Array(input)
  }

  if (typeof input === 'string') {
    try {
      const bytes = Uint8Array.from(atob(input), (char) => char.charCodeAt(0))
      return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
    } catch {
      return null
    }
  }

  return null
}

const decodeRawByteArray = (input: unknown): Uint8Array | null => {
  if (!input) return null
  if (input instanceof Uint8Array) return input

  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }

  return null
}

type RawWaveformPayload = {
  minLeft?: unknown
  min?: unknown
  maxLeft?: unknown
  max?: unknown
  minRight?: unknown
  maxRight?: unknown
  meanLeft?: unknown
  meanRight?: unknown
  rmsLeft?: unknown
  rmsRight?: unknown
  frames?: unknown
  duration?: unknown
  sampleRate?: unknown
  rate?: unknown
  compactColorIndex?: unknown
  compactColorLow?: unknown
  compactColorMid?: unknown
  compactColorHigh?: unknown
  compactColorRed?: unknown
  compactColorGreen?: unknown
  compactColorBlue?: unknown
  compactColorRateDivisor?: unknown
  compactColorStartFrame?: unknown
}

const decodeRawWaveformData = (payload: unknown): RawWaveformData | null => {
  const source =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as RawWaveformPayload)
      : null
  if (!source) return null
  const minLeft = decodeRawFloatArray(source.minLeft ?? source.min)
  const maxLeft = decodeRawFloatArray(source.maxLeft ?? source.max)
  const minRight = decodeRawFloatArray(source.minRight ?? source.min)
  const maxRight = decodeRawFloatArray(source.maxRight ?? source.max)
  const meanLeft = decodeRawFloatArray(source.meanLeft)
  const meanRight = decodeRawFloatArray(source.meanRight)
  const rmsLeft = decodeRawFloatArray(source.rmsLeft)
  const rmsRight = decodeRawFloatArray(source.rmsRight)
  const compactColorIndex = decodeRawByteArray(source.compactColorIndex)
  const compactColorLow = decodeRawByteArray(source.compactColorLow)
  const compactColorMid = decodeRawByteArray(source.compactColorMid)
  const compactColorHigh = decodeRawByteArray(source.compactColorHigh)
  const compactColorRed = decodeRawByteArray(source.compactColorRed)
  const compactColorGreen = decodeRawByteArray(source.compactColorGreen)
  const compactColorBlue = decodeRawByteArray(source.compactColorBlue)
  if (!minLeft || !maxLeft || !minRight || !maxRight) return null

  const frames = Math.max(
    0,
    Math.min(
      Number(source.frames) || Number.POSITIVE_INFINITY,
      minLeft.length,
      maxLeft.length,
      minRight.length,
      maxRight.length
    )
  )

  const normalized: RawWaveformData = {
    duration: Number(source.duration) || 0,
    sampleRate: Number(source.sampleRate) || 0,
    rate: Number(source.rate) || 0,
    frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight
  }
  if (rmsLeft && rmsRight && rmsLeft.length >= frames && rmsRight.length >= frames) {
    normalized.rmsLeft = rmsLeft
    normalized.rmsRight = rmsRight
  }
  if (meanLeft && meanRight && meanLeft.length >= frames && meanRight.length >= frames) {
    normalized.meanLeft = meanLeft
    normalized.meanRight = meanRight
  }
  if (compactColorIndex?.length) normalized.compactColorIndex = compactColorIndex
  if (compactColorLow?.length) normalized.compactColorLow = compactColorLow
  if (compactColorMid?.length) normalized.compactColorMid = compactColorMid
  if (compactColorHigh?.length) normalized.compactColorHigh = compactColorHigh
  if (compactColorRed?.length) normalized.compactColorRed = compactColorRed
  if (compactColorGreen?.length) normalized.compactColorGreen = compactColorGreen
  if (compactColorBlue?.length) normalized.compactColorBlue = compactColorBlue
  if (Number.isFinite(Number(source.compactColorRateDivisor))) {
    normalized.compactColorRateDivisor = Math.max(
      1,
      Math.floor(Number(source.compactColorRateDivisor) || 1)
    )
  }
  if (Number.isFinite(Number(source.compactColorStartFrame))) {
    normalized.compactColorStartFrame = Math.max(
      0,
      Math.floor(Number(source.compactColorStartFrame) || 0)
    )
  }

  return normalized
}

export const pickRawDataByFile = (
  response: { items?: Array<{ filePath?: string; data?: unknown }> } | null | undefined,
  fileKey: string,
  normalizePathKey: (value: unknown) => string
): RawWaveformData | null => {
  const items = Array.isArray(response?.items) ? response.items : []
  const item = items.find((entry) => normalizePathKey(entry?.filePath) === fileKey)
  return decodeRawWaveformData(item?.data ?? null)
}
