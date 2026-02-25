import { computed, type Ref } from 'vue'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildMixEnvelopePolylineByControlPoints,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import type {
  MixtapeEnvelopeParamId,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type MaybeRef<T> = Readonly<Ref<T>> | T

type UseMixtapeEnvelopePreviewOptions = {
  laneIndices: MaybeRef<number[]>
  laneHeight: MaybeRef<number>
  timelineVisualScale: MaybeRef<number>
  timelineContentWidth: MaybeRef<number>
  timelineScrollLeft: MaybeRef<number>
  tracks: Readonly<Ref<MixtapeTrack[]>>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
}

type TrackEnvelopePreviewLine = {
  key: MixtapeEnvelopeParamId
  points: string
  color: string
  strokeWidth: number
}

const TRACK_ENVELOPE_PREVIEW_PARAMS: MixtapeEnvelopeParamId[] = [
  'gain',
  'high',
  'mid',
  'low',
  'volume'
]

const TRACK_ENVELOPE_PREVIEW_COLORS: Record<MixtapeEnvelopeParamId, string> = {
  gain: '#f2f6ff',
  high: '#4f8bff',
  mid: '#45d07e',
  low: '#ff5d61',
  volume: '#ffc94a'
}

const TRACK_ENVELOPE_PREVIEW_STROKES: Record<MixtapeEnvelopeParamId, number> = {
  gain: 1.2,
  high: 1.08,
  mid: 1.08,
  low: 1.08,
  volume: 0.95
}

const TRACK_ENVELOPE_PREVIEW_EDGE_INSET_PERCENT = 1.2

const TIMELINE_TRACK_LANE_GAP_PX = 8
const TIMELINE_TRACK_VERTICAL_PADDING_PX = 10
const TIMELINE_TRACK_LANE_BORDER_PX = 2
const TIMELINE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT_PX = 63
const TIMELINE_OVERVIEW_BASE_LANE_HEIGHT_PX = 12

const normalizeEnvelopePreviewPolyline = (points: string) =>
  points.replace(
    /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
    (_matched, xText: string, yText: string) => {
      const y = Number(yText)
      if (!Number.isFinite(y)) return `${xText},${yText}`
      const safeY = Math.max(
        TRACK_ENVELOPE_PREVIEW_EDGE_INSET_PERCENT,
        Math.min(100 - TRACK_ENVELOPE_PREVIEW_EDGE_INSET_PERCENT, y)
      )
      return `${xText},${safeY.toFixed(3)}`
    }
  )

const unwrapMaybeRef = <T>(value: MaybeRef<T>): T => {
  if (value && typeof value === 'object' && 'value' in (value as any)) {
    return (value as Readonly<Ref<T>>).value
  }
  return value as T
}

export const useMixtapeEnvelopePreview = (options: UseMixtapeEnvelopePreviewOptions) => {
  const trackEnvelopePreviewLegend = TRACK_ENVELOPE_PREVIEW_PARAMS.map((param) => ({
    key: param,
    label: param.toUpperCase(),
    color: TRACK_ENVELOPE_PREVIEW_COLORS[param]
  }))

  const timelineTrackAreaHeight = computed(() => {
    const laneIndices = unwrapMaybeRef(options.laneIndices)
    const laneHeight = unwrapMaybeRef(options.laneHeight)
    const laneCount = Math.max(0, Array.isArray(laneIndices) ? laneIndices.length : 0)
    const safeLaneHeight = Math.max(0, Number(laneHeight) || 0)
    if (!laneCount || !safeLaneHeight) return 0
    const laneOuterHeight = safeLaneHeight + TIMELINE_TRACK_LANE_BORDER_PX
    const gaps = Math.max(0, laneCount - 1) * TIMELINE_TRACK_LANE_GAP_PX
    const verticalPadding = TIMELINE_TRACK_VERTICAL_PADDING_PX * 2
    return Math.round(laneOuterHeight * laneCount + gaps + verticalPadding)
  })

  const timelineAdaptiveStyle = computed(() => {
    const scale = Math.max(1, Number(unwrapMaybeRef(options.timelineVisualScale)) || 1)
    return {
      '--timeline-envelope-preview-lane-height': `${Math.max(
        1,
        Math.round(TIMELINE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT_PX * scale)
      )}px`,
      '--timeline-overview-lane-height': `${Math.max(
        1,
        Math.round(TIMELINE_OVERVIEW_BASE_LANE_HEIGHT_PX * scale)
      )}px`
    }
  })

  const resolveTrackEnvelopePreviewLines = (
    item: TimelineTrackLayout
  ): TrackEnvelopePreviewLine[] => {
    const currentTrack =
      options.tracks.value.find((track) => track.id === item.track.id) || item.track
    const durationSec = Math.max(0, Number(options.resolveTrackDurationSeconds(currentTrack)) || 0)
    if (!durationSec) return []
    return TRACK_ENVELOPE_PREVIEW_PARAMS.map((param) => {
      const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
      const normalizedPoints = normalizeMixEnvelopePoints(
        param,
        (currentTrack as Record<string, unknown>)[envelopeField],
        durationSec
      )
      if (normalizedPoints.length < 2) return null
      const points = buildMixEnvelopePolylineByControlPoints({
        param,
        points: normalizedPoints,
        durationSec
      })
      if (!points) return null
      return {
        key: param,
        points: normalizeEnvelopePreviewPolyline(points),
        color: TRACK_ENVELOPE_PREVIEW_COLORS[param],
        strokeWidth: TRACK_ENVELOPE_PREVIEW_STROKES[param]
      }
    }).filter((line): line is TrackEnvelopePreviewLine => line !== null)
  }

  const trackEnvelopePreviewViewportStyle = computed(() => {
    const safeWidth = Math.max(0, Number(unwrapMaybeRef(options.timelineContentWidth)) || 0)
    const safeScrollLeft = Math.max(0, Number(unwrapMaybeRef(options.timelineScrollLeft)) || 0)
    return {
      width: `${safeWidth}px`,
      transform: `translate3d(${-safeScrollLeft}px, 0, 0)`
    }
  })

  return {
    trackEnvelopePreviewLegend,
    timelineTrackAreaHeight,
    timelineAdaptiveStyle,
    resolveTrackEnvelopePreviewLines,
    trackEnvelopePreviewViewportStyle
  }
}
