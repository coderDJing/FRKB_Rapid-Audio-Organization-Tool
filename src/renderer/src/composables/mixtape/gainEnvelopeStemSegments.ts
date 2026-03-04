import { normalizeMixEnvelopePoints } from '@renderer/composables/mixtape/gainEnvelope'
import { clampNumber } from '@renderer/composables/mixtape/gainEnvelopeEditorGrid'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment
} from '@renderer/composables/mixtape/types'

export const STEM_SEGMENT_MUTE_GAIN = 0.0001
export const STEM_SEGMENT_ACTIVE_GAIN = 1
export const STEM_SEGMENT_MUTE_THRESHOLD = 0.5

export const buildStemEnvelopeBySegments = (
  param: MixtapeEnvelopeParamId,
  durationSec: number,
  segments: MixtapeMuteSegment[]
): MixtapeGainPoint[] => {
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  if (!safeDuration) {
    return normalizeMixEnvelopePoints(param, [{ sec: 0, gain: STEM_SEGMENT_ACTIVE_GAIN }], 0)
  }
  const epsilon = 0.0001
  const events = segments
    .flatMap((segment) => {
      const safeStart = clampNumber(Number(segment.startSec) || 0, 0, safeDuration)
      const safeEnd = clampNumber(Number(segment.endSec) || 0, 0, safeDuration)
      if (safeEnd - safeStart <= epsilon) return []
      return [
        { sec: Number(safeStart.toFixed(4)), delta: 1 },
        { sec: Number(safeEnd.toFixed(4)), delta: -1 }
      ]
    })
    .sort((left, right) => {
      if (Math.abs(left.sec - right.sec) > epsilon) return left.sec - right.sec
      return right.delta - left.delta
    })

  let cursor = 0
  let depth = 0
  while (cursor < events.length && events[cursor].sec <= epsilon) {
    depth = Math.max(0, depth + events[cursor].delta)
    cursor += 1
  }

  const points: MixtapeGainPoint[] = [
    { sec: 0, gain: depth > 0 ? STEM_SEGMENT_MUTE_GAIN : STEM_SEGMENT_ACTIVE_GAIN }
  ]

  while (cursor < events.length) {
    const sec = events[cursor].sec
    if (sec >= safeDuration - epsilon) break
    const beforeGain = depth > 0 ? STEM_SEGMENT_MUTE_GAIN : STEM_SEGMENT_ACTIVE_GAIN
    const last = points[points.length - 1]
    if (!last || Math.abs(last.sec - sec) > epsilon || Math.abs(last.gain - beforeGain) > epsilon) {
      points.push({ sec: Number(sec.toFixed(4)), gain: beforeGain })
    }
    while (cursor < events.length && Math.abs(events[cursor].sec - sec) <= epsilon) {
      depth = Math.max(0, depth + events[cursor].delta)
      cursor += 1
    }
    const afterGain = depth > 0 ? STEM_SEGMENT_MUTE_GAIN : STEM_SEGMENT_ACTIVE_GAIN
    if (Math.abs(afterGain - beforeGain) > epsilon) {
      points.push({ sec: Number(sec.toFixed(4)), gain: afterGain })
    }
  }

  const tailGain = depth > 0 ? STEM_SEGMENT_MUTE_GAIN : STEM_SEGMENT_ACTIVE_GAIN
  points.push({
    sec: Number(safeDuration.toFixed(4)),
    gain: tailGain
  })
  return normalizeMixEnvelopePoints(param, points, safeDuration)
}
