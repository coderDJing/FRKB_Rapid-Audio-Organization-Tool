import { computed } from 'vue'
import { TIMELINE_SIDE_PADDING_PX } from '@renderer/composables/mixtape/constants'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  MIXTAPE_GAIN_KNOB_MAX_DB,
  MIXTAPE_GAIN_KNOB_MIN_DB,
  buildFlatMixEnvelope,
  linearGainToDb,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  isSecMutedBySegments,
  normalizeVolumeMuteSegments
} from '@renderer/composables/mixtape/volumeMuteSegments'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type TransportEntryLike = {
  trackId: string
  duration: number
  mixEnvelopes: Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>
  mixEnvelopeSources: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
  volumeMuteSegments: MixtapeMuteSegment[]
  volumeMuteSegmentsSource?: MixtapeMuteSegment[]
}

export const createTimelineTransportResolversModule = (ctx: any) => {
  const {
    tracks,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollLeft,
    timelineViewportWidth,
    rulerRef,
    playheadSec,
    playheadVisible,
    transportPreloadDone,
    transportPreloadTotal,
    transportDurationSecRef,
    computeTimelineDuration,
    resolveRenderPxPerSec,
    buildSequentialLayoutForZoom,
    clampNumber,
    mixEnvelopeParams,
    segmentMuteGain
  } = ctx

  const timelineDurationSec = computed(() => computeTimelineDuration())
  const transportPreloadPercent = computed(() => {
    if (!transportPreloadTotal.value) return 0
    return clampNumber(
      Math.round((transportPreloadDone.value / transportPreloadTotal.value) * 100),
      0,
      100
    )
  })

  const resolveTimelineDisplayX = (sec: number, pxPerSec: number, maxX: number) => {
    const x = TIMELINE_SIDE_PADDING_PX + sec * pxPerSec
    return clampNumber(x, TIMELINE_SIDE_PADDING_PX, maxX)
  }

  const resolveTimelineSecByX = (x: number, pxPerSec: number) => {
    if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return 0
    const timelineX = Math.max(0, x - TIMELINE_SIDE_PADDING_PX)
    return Math.max(0, timelineX / pxPerSec)
  }

  const resolveRulerLeftInset = () => {
    const rulerEl = (rulerRef?.value as HTMLElement | null) || null
    if (!rulerEl) return 0
    const inset = Number(rulerEl.clientLeft || 0)
    if (!Number.isFinite(inset) || inset <= 0) return 0
    return inset
  }

  const snapViewportX = (value: number) => {
    const safe = Math.max(0, Number(value) || 0)
    if (typeof window === 'undefined') return safe
    const dpr = Number(window.devicePixelRatio || 1)
    if (!Number.isFinite(dpr) || dpr <= 0) return safe
    return Math.round(safe * dpr) / dpr
  }

  const resolveTransportDuration = () => {
    const total =
      Number(transportDurationSecRef.value) > 0
        ? Number(transportDurationSecRef.value)
        : timelineDurationSec.value
    if (!Number.isFinite(total) || total <= 0) return 0
    return total
  }

  const overviewPlayheadStyle = computed(() => ({
    left: `${clampNumber(
      resolveTransportDuration() <= 0 ? 0 : (playheadSec.value / resolveTransportDuration()) * 100,
      0,
      100
    )}%`,
    opacity: playheadVisible.value ? '1' : '0'
  }))

  const playheadViewportX = computed(() => {
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalSec = resolveTransportDuration()
    if (!totalSec || !totalWidth) return TIMELINE_SIDE_PADDING_PX
    const maxX = Math.max(TIMELINE_SIDE_PADDING_PX, totalWidth + TIMELINE_SIDE_PADDING_PX)
    const x = resolveTimelineDisplayX(playheadSec.value, pxPerSec, maxX)
    const scrollLeft = Math.max(0, Number(timelineScrollLeft.value) || 0)
    return Math.max(0, x - scrollLeft)
  })

  const playheadViewportStyle = computed(() => ({
    left: `${snapViewportX(playheadViewportX.value)}px`,
    opacity: playheadVisible.value ? '1' : '0'
  }))

  const rulerPlayheadStyle = computed(() => {
    const rulerInset = resolveRulerLeftInset()
    return {
      left: `${snapViewportX(Math.max(0, playheadViewportX.value - rulerInset))}px`,
      opacity: playheadVisible.value ? '1' : '0'
    }
  })

  const timelinePlayheadStyle = computed(() => {
    return playheadViewportStyle.value
  })

  const formatTransportTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00'
    const total = Math.floor(seconds)
    const min = Math.floor(total / 60)
    const sec = total % 60
    const fraction = Math.floor((seconds - total) * 100)
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
  }

  const playheadTimeLabel = computed(() => formatTransportTime(playheadSec.value))
  const timelineDurationLabel = computed(() => formatTransportTime(timelineDurationSec.value))
  const rulerMinuteTicks = computed(() => {
    type RulerTickAlign = 'start' | 'center' | 'end'
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalWidth = Math.max(1, timelineLayout.value.totalWidth)
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || totalWidth)
    const maxScroll = Math.max(0, totalWidth - viewportWidth)
    const viewportStartX = clampNumber(Number(timelineScrollLeft.value) || 0, 0, maxScroll)
    const viewportEndX = viewportStartX + viewportWidth
    const viewportStartSec = resolveTimelineSecByX(viewportStartX, pxPerSec)
    const viewportEndSec = Math.max(viewportStartSec, resolveTimelineSecByX(viewportEndX, pxPerSec))
    const timelineEndSec = Math.max(0, timelineDurationSec.value)
    if (viewportWidth <= 0 || timelineEndSec <= 0) {
      return [] as Array<{ left: string; value: number; align: RulerTickAlign }>
    }

    const firstMinute = Math.ceil(viewportStartSec / 60)
    const endMinute = Math.floor(Math.min(viewportEndSec, timelineEndSec) / 60)
    const ticks: Array<{ left: string; value: number; align: RulerTickAlign }> = []
    for (let minute = firstMinute; minute <= endMinute; minute += 1) {
      const sec = minute * 60
      const x = resolveTimelineDisplayX(sec, pxPerSec, totalWidth)
      const localX = x - viewportStartX
      const ratio = clampNumber(localX / viewportWidth, 0, 1)
      const left = `${(ratio * 100).toFixed(4)}%`
      let align: RulerTickAlign = 'center'
      if (ratio <= 0.0001 || minute === 0) {
        align = 'start'
      } else if (ratio >= 0.9999 || Math.abs(sec - timelineEndSec) <= 0.0001) {
        align = 'end'
      }
      ticks.push({ left, value: minute, align })
    }
    return ticks
  })

  const rulerInactiveStyle = computed<Record<string, string> | null>(() => {
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || 0)
    if (totalWidth <= 0 || viewportWidth <= 0 || totalWidth >= viewportWidth) return null
    const activeRatio = clampNumber(totalWidth / viewportWidth, 0, 1)
    const inactiveRatio = 1 - activeRatio
    if (inactiveRatio <= 0.0001) return null
    return {
      left: `${(activeRatio * 100).toFixed(4)}%`,
      width: `${(inactiveRatio * 100).toFixed(4)}%`
    }
  })

  const resolveTrackStartSec = (track: MixtapeTrack) => {
    const numeric = Number(track.startSec)
    if (Number.isFinite(numeric) && numeric >= 0) return numeric
    return 0
  }

  const resolveTrackStartSecById = (trackId: string) => {
    if (!trackId) return 0
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const snapshot = buildSequentialLayoutForZoom(normalizedRenderZoom.value)
    const item = snapshot.layout.find(
      (candidate: TimelineTrackLayout) => candidate.track.id === trackId
    )
    if (!item) return 0
    const layoutStartSec = Number(item.startSec)
    if (Number.isFinite(layoutStartSec) && layoutStartSec >= 0) return layoutStartSec
    return resolveTimelineSecByX(item.startX, pxPerSec)
  }

  const resolveTrackMixEnvelope = (
    track: MixtapeTrack,
    durationSec: number,
    param: MixtapeEnvelopeParamId
  ) => {
    const safeDuration = Math.max(0, Number(durationSec) || 0)
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const normalized = normalizeMixEnvelopePoints(
      param,
      (track as any)?.[envelopeField],
      safeDuration
    )
    if (normalized.length > 0) return normalized
    return buildFlatMixEnvelope(param, safeDuration, 1)
  }

  const resolveEntryEnvelopeValue = (
    entry: TransportEntryLike,
    param: MixtapeEnvelopeParamId,
    timelineOffsetSec: number
  ) => {
    const latestTrack = tracks.value.find((track: MixtapeTrack) => track.id === entry.trackId)
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const latestEnvelopeSource = latestTrack
      ? ((latestTrack as any)?.[envelopeField] as MixtapeGainPoint[] | undefined)
      : undefined
    if (latestTrack && latestEnvelopeSource !== entry.mixEnvelopeSources[param]) {
      entry.mixEnvelopes[param] = resolveTrackMixEnvelope(latestTrack, entry.duration, param)
      entry.mixEnvelopeSources[param] = latestEnvelopeSource
    }
    if (param === 'volume' && latestTrack) {
      const latestMuteSource = latestTrack.volumeMuteSegments
      if (latestMuteSource !== entry.volumeMuteSegmentsSource) {
        entry.volumeMuteSegments = normalizeVolumeMuteSegments(latestMuteSource, entry.duration)
        entry.volumeMuteSegmentsSource = latestMuteSource
      }
    }
    const safeOffset = clampNumber(timelineOffsetSec, 0, Math.max(0, entry.duration))
    const envelopeGain = sampleMixEnvelopeAtSec(param, entry.mixEnvelopes[param], safeOffset, 1)
    if (param !== 'volume') return envelopeGain
    const muted = isSecMutedBySegments(entry.volumeMuteSegments, safeOffset)
    return muted ? segmentMuteGain : envelopeGain
  }

  const resolveEntryEqDbValue = (
    entry: TransportEntryLike,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => {
    const gain = resolveEntryEnvelopeValue(entry, param, timelineOffsetSec)
    return clampNumber(linearGainToDb(gain), MIXTAPE_GAIN_KNOB_MIN_DB, MIXTAPE_GAIN_KNOB_MAX_DB)
  }

  return {
    timelineDurationSec,
    transportPreloadPercent,
    resolveTimelineDisplayX,
    resolveTimelineSecByX,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    resolveTrackStartSec,
    resolveTrackStartSecById,
    resolveTrackMixEnvelope,
    resolveEntryEnvelopeValue,
    resolveEntryEqDbValue
  }
}
