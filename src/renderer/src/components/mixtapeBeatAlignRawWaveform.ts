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

const decodeRawWaveformData = (payload: any): RawWaveformData | null => {
  if (!payload) return null
  const minLeft = decodeRawFloatArray(payload.minLeft ?? payload.min)
  const maxLeft = decodeRawFloatArray(payload.maxLeft ?? payload.max)
  const minRight = decodeRawFloatArray(payload.minRight ?? payload.min)
  const maxRight = decodeRawFloatArray(payload.maxRight ?? payload.max)
  if (!minLeft || !maxLeft || !minRight || !maxRight) return null

  const frames = Math.max(
    0,
    Math.min(
      Number(payload.frames) || Number.POSITIVE_INFINITY,
      minLeft.length,
      maxLeft.length,
      minRight.length,
      maxRight.length
    )
  )

  return {
    duration: Number(payload.duration) || 0,
    sampleRate: Number(payload.sampleRate) || 0,
    rate: Number(payload.rate) || 0,
    frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight
  }
}

export const pickRawDataByFile = (
  response: any,
  fileKey: string,
  normalizePathKey: (value: unknown) => string
): RawWaveformData | null => {
  const items = Array.isArray(response?.items) ? response.items : []
  const item = items.find((entry: any) => normalizePathKey(entry?.filePath) === fileKey)
  return decodeRawWaveformData(item?.data ?? null)
}
