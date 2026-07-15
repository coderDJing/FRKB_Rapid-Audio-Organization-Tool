import type { MixSegmentMask } from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type { MixtapeMuteSegment } from '@renderer/composables/mixtape/types'

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const resolveVolumeMuteSegmentKey = (segment: MixtapeMuteSegment) =>
  `${Number(segment.startSec).toFixed(4)}:${Number(segment.endSec).toFixed(4)}`

export const resolveVolumeMutePointerSec = (
  stageEl: HTMLElement,
  event: MouseEvent,
  durationSec: number
) => {
  const rect = stageEl.getBoundingClientRect()
  if (!rect.width || !durationSec) return null
  const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
  return Number((xRatio * durationSec).toFixed(4))
}

export const resolveVolumeMuteSegmentMasks = (
  durationSec: number,
  segments: MixtapeMuteSegment[]
): MixSegmentMask[] => {
  if (!durationSec || !segments.length) return []
  return segments
    .map((segment) => {
      const startRatio = clampNumber(segment.startSec / durationSec, 0, 1)
      const endRatio = clampNumber(segment.endSec / durationSec, 0, 1)
      const widthRatio = Math.max(0, endRatio - startRatio)
      if (widthRatio <= 0.0001) return null
      return {
        key: resolveVolumeMuteSegmentKey(segment),
        left: Number((startRatio * 100).toFixed(4)),
        width: Number((widthRatio * 100).toFixed(4))
      }
    })
    .filter((segment): segment is MixSegmentMask => segment !== null)
}

export const resolveVolumeMuteSegmentsByToggle = (
  baseSegments: MixtapeMuteSegment[],
  touched: Map<string, MixtapeMuteSegment>
) => {
  const nextMap = new Map(
    baseSegments.map((segment) => [resolveVolumeMuteSegmentKey(segment), segment])
  )
  for (const [key, segment] of touched.entries()) {
    if (nextMap.has(key)) {
      nextMap.delete(key)
    } else {
      nextMap.set(key, segment)
    }
  }
  return Array.from(nextMap.values())
}
