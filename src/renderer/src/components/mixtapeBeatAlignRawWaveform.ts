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

type RawWaveformPayload = {
  minLeft?: unknown
  min?: unknown
  maxLeft?: unknown
  max?: unknown
  minRight?: unknown
  maxRight?: unknown
  frames?: unknown
  duration?: unknown
  sampleRate?: unknown
  rate?: unknown
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

  return {
    duration: Number(source.duration) || 0,
    sampleRate: Number(source.sampleRate) || 0,
    rate: Number(source.rate) || 0,
    frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight
  }
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
