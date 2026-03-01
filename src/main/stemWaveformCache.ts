import type { MixtapeStemMode } from './mixtapeDb'
import type { MixxxWaveformBand } from './waveformCache'

export const STEM_WAVEFORM_CACHE_VERSION = 2

export type StemWaveformStemId = 'vocal' | 'harmonic' | 'bass' | 'drums'

export type StemWaveformDataLite = {
  duration: number
  sampleRate: number
  step: number
  all: MixxxWaveformBand
}

export type StemWaveformData = {
  stemMode: MixtapeStemMode
  stems: Partial<Record<StemWaveformStemId, StemWaveformDataLite>>
}

type EncodedStemWaveformMeta = {
  stemId: StemWaveformStemId
  offset: number
  length: number
  sampleRate: number
  step: number
  duration: number
  frames: number
}

type EncodedStemWaveformContainer = {
  version: number
  stemMode: MixtapeStemMode
  stems: EncodedStemWaveformMeta[]
}

const STEM_IDS_4: StemWaveformStemId[] = ['vocal', 'harmonic', 'bass', 'drums']

const normalizeStemMode = (_value: unknown): MixtapeStemMode => '4stems'

const resolveStemIds = (_stemMode: MixtapeStemMode): StemWaveformStemId[] => STEM_IDS_4

const normalizeStemId = (value: unknown): StemWaveformStemId | null => {
  if (value === 'vocal') return 'vocal'
  if (value === 'harmonic') return 'harmonic'
  if (value === 'bass') return 'bass'
  if (value === 'drums') return 'drums'
  return null
}

export function encodeStemWaveformData(
  data: StemWaveformData
): { metaJson: string; payload: Buffer } | null {
  const stemMode = normalizeStemMode(data?.stemMode)
  const stemIds = resolveStemIds(stemMode)
  const encodedMeta: EncodedStemWaveformMeta[] = []
  const encodedBuffers: Buffer[] = []
  let offset = 0

  for (const stemId of stemIds) {
    const stemData = data?.stems?.[stemId]
    if (!stemData) return null
    const all = stemData.all
    if (!all) return null
    const frames = all.left.length
    if (!frames) return null
    if (
      all.right.length !== frames ||
      all.peakLeft.length !== frames ||
      all.peakRight.length !== frames
    ) {
      return null
    }
    const payload = Buffer.concat([
      Buffer.from(all.left),
      Buffer.from(all.right),
      Buffer.from(all.peakLeft),
      Buffer.from(all.peakRight)
    ])
    if (!payload.length) return null
    encodedMeta.push({
      stemId,
      offset,
      length: payload.length,
      sampleRate: stemData.sampleRate,
      step: stemData.step,
      duration: stemData.duration,
      frames
    })
    encodedBuffers.push(payload)
    offset += payload.length
  }

  if (!encodedMeta.length) return null
  const container: EncodedStemWaveformContainer = {
    version: STEM_WAVEFORM_CACHE_VERSION,
    stemMode,
    stems: encodedMeta
  }
  return {
    metaJson: JSON.stringify(container),
    payload: Buffer.concat(encodedBuffers)
  }
}

export function decodeStemWaveformData(metaJson: string, payload: Buffer): StemWaveformData | null {
  if (!metaJson || !payload) return null
  let parsed: EncodedStemWaveformContainer | null = null
  try {
    parsed = JSON.parse(metaJson) as EncodedStemWaveformContainer
  } catch {
    return null
  }
  if (!parsed || Number(parsed.version) !== STEM_WAVEFORM_CACHE_VERSION) return null
  const stemMode = normalizeStemMode(parsed.stemMode)
  const requiredStemIds = resolveStemIds(stemMode)
  const stemMap: Partial<Record<StemWaveformStemId, StemWaveformDataLite>> = {}

  for (const item of Array.isArray(parsed.stems) ? parsed.stems : []) {
    const stemId = normalizeStemId(item?.stemId)
    if (!stemId) continue
    const offset = Number(item?.offset)
    const length = Number(item?.length)
    const sampleRate = Number(item?.sampleRate)
    const step = Number(item?.step)
    const duration = Number(item?.duration)
    const frames = Number(item?.frames)
    if (
      !Number.isFinite(offset) ||
      !Number.isFinite(length) ||
      !Number.isFinite(sampleRate) ||
      !Number.isFinite(step) ||
      !Number.isFinite(duration) ||
      !Number.isFinite(frames)
    ) {
      return null
    }
    const safeOffset = Math.max(0, Math.floor(offset))
    const safeLength = Math.max(0, Math.floor(length))
    if (!safeLength || safeOffset + safeLength > payload.length) return null
    const frameCount = Math.max(0, Math.floor(frames))
    if (!frameCount) return null
    const expectedLength = frameCount * 4
    if (safeLength < expectedLength) return null
    const stemPayload = payload.subarray(safeOffset, safeOffset + safeLength)
    let cursor = 0
    const readBand = () => {
      const slice = stemPayload.subarray(cursor, cursor + frameCount)
      cursor += frameCount
      return slice
    }
    const all = {
      left: readBand(),
      right: readBand(),
      peakLeft: readBand(),
      peakRight: readBand()
    }
    stemMap[stemId] = {
      duration,
      sampleRate: Math.floor(sampleRate),
      step,
      all
    }
  }

  for (const stemId of requiredStemIds) {
    if (!stemMap[stemId]) return null
  }

  return {
    stemMode,
    stems: stemMap
  }
}
