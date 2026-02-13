import type { RawWaveformData, RawWaveformLevel } from '@renderer/composables/mixtape/types'

export const buildRawWaveformPyramid = (raw: RawWaveformData): RawWaveformLevel[] => {
  const levels: RawWaveformLevel[] = []
  const base: RawWaveformLevel = { ...raw, factor: 1 }
  levels.push(base)
  let current = base
  while (current.frames > 256 && levels.length < 8) {
    const nextFrames = Math.floor(current.frames / 2)
    if (nextFrames <= 1) break
    const minLeft = new Float32Array(nextFrames)
    const maxLeft = new Float32Array(nextFrames)
    const minRight = new Float32Array(nextFrames)
    const maxRight = new Float32Array(nextFrames)
    for (let i = 0; i < nextFrames; i += 1) {
      const i0 = i * 2
      const i1 = Math.min(current.frames - 1, i0 + 1)
      minLeft[i] = Math.min(current.minLeft[i0] ?? 0, current.minLeft[i1] ?? 0)
      maxLeft[i] = Math.max(current.maxLeft[i0] ?? 0, current.maxLeft[i1] ?? 0)
      minRight[i] = Math.min(current.minRight[i0] ?? 0, current.minRight[i1] ?? 0)
      maxRight[i] = Math.max(current.maxRight[i0] ?? 0, current.maxRight[i1] ?? 0)
    }
    const next: RawWaveformLevel = {
      duration: current.duration,
      sampleRate: current.sampleRate,
      rate: current.rate / 2,
      frames: nextFrames,
      minLeft,
      maxLeft,
      minRight,
      maxRight,
      factor: current.factor * 2
    }
    levels.push(next)
    current = next
  }
  return levels
}

export const resolveRawWaveformLevel = (
  rawWaveformPyramidMap: Map<string, RawWaveformLevel[]>,
  filePath: string,
  raw: RawWaveformData | null,
  samplesPerPixel: number
): RawWaveformData | null => {
  if (!raw || !filePath) return raw
  let levels = rawWaveformPyramidMap.get(filePath)
  if (!levels) {
    levels = buildRawWaveformPyramid(raw)
    rawWaveformPyramidMap.set(filePath, levels)
  }
  if (!levels.length) return raw
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 1) return levels[0]
  let target = 1
  while (target * 2 <= samplesPerPixel && target < 128) {
    target *= 2
  }
  let best = levels[0]
  let bestDiff = Math.abs(best.factor - target)
  for (const level of levels) {
    const diff = Math.abs(level.factor - target)
    if (diff < bestDiff) {
      best = level
      bestDiff = diff
    }
  }
  return best
}
