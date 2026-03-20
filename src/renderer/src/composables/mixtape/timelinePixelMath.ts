import { TIMELINE_SIDE_PADDING_PX } from '@renderer/composables/mixtape/constants'

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const resolveRoundedTimelineOffsetPx = (sec: number, pxPerSec: number) => {
  const safeSec = Number.isFinite(Number(sec)) ? Number(sec) : 0
  const safePxPerSec = Math.max(0, Number(pxPerSec) || 0)
  return Math.round(safeSec * safePxPerSec)
}

export const resolveRoundedTimelineAbsolutePx = (sec: number, pxPerSec: number) =>
  TIMELINE_SIDE_PADDING_PX + resolveRoundedTimelineOffsetPx(sec, pxPerSec)

export const resolveRoundedTrackLocalPx = (params: {
  trackStartSec: number
  localSec: number
  pxPerSec: number
}) => {
  const trackStartSec = Number.isFinite(Number(params.trackStartSec))
    ? Number(params.trackStartSec)
    : 0
  const localSec = Math.max(0, Number(params.localSec) || 0)
  const pxPerSec = Math.max(0, Number(params.pxPerSec) || 0)
  return clampNumber(
    resolveRoundedTimelineOffsetPx(trackStartSec + localSec, pxPerSec) -
      resolveRoundedTimelineOffsetPx(trackStartSec, pxPerSec),
    0,
    Number.POSITIVE_INFINITY
  )
}
