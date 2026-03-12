import { computed } from 'vue'
import {
  BASE_PX_PER_SEC,
  FALLBACK_TRACK_WIDTH,
  GRID_BEAT4_LINE_ZOOM,
  GRID_BEAT_LINE_ZOOM,
  GRID_BAR_WIDTH_MAX,
  GRID_BAR_WIDTH_MAX_ZOOM,
  GRID_BAR_WIDTH_MIN,
  LANE_COUNT,
  MIXXX_MAX_RGB_ENERGY,
  MIXTAPE_BASE_TRACK_LANE_HEIGHT,
  MIXTAPE_WAVEFORM_HEIGHT_SCALE,
  MIN_TRACK_WIDTH,
  TIMELINE_SIDE_PADDING_PX,
  MIXTAPE_WIDTH_SCALE,
  RAW_WAVEFORM_MIN_ZOOM,
  RENDER_ZOOM_STEP,
  WAVEFORM_TILE_WIDTH,
  ZOOM_MAX,
  ZOOM_MIN
} from '@renderer/composables/mixtape/constants'
import {
  normalizeBeatOffset as normalizeBeatOffsetByMixxx,
  resolveFirstBeatTimelineSec,
  resolveTempoRatioByBpm
} from '@renderer/composables/mixtape/mixxxSyncModel'
import {
  buildTrackVisibleGridLines,
  normalizeTrackBpmEnvelopePoints,
  resolveTrackBpmEnvelopeBaseValue,
  resolveTrackGridSourceBpm
} from '@renderer/composables/mixtape/trackBpmEnvelope'
import { resolveTrackTimelineDurationFromSource } from '@renderer/composables/mixtape/trackBpmEnvelope'
import {
  buildGainEnvelopePolylineByControlPoints,
  normalizeGainEnvelopePoints,
  MIXTAPE_GAIN_KNOB_MAX_DB,
  MIXTAPE_GAIN_KNOB_MIN_DB
} from '@renderer/composables/mixtape/gainEnvelope'
import { resolveRawWaveformLevel as resolveRawWaveformLevelByMap } from '@renderer/composables/mixtape/waveformPyramid'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type {
  MinMaxSample,
  MixtapeMixMode,
  MixtapeTrack,
  MixtapeWaveformStemId,
  RawWaveformData,
  StemWaveformData,
  TimelineLayoutSnapshot,
  TimelineTrackLayout,
  WaveformTile
} from '@renderer/composables/mixtape/types'

type TrackWaveformSource = {
  filePath: string
  listRoot: string
  laneIndex: number
  laneCount: number
  stemId: MixtapeWaveformStemId
}

export const createTimelineHelpersModule = (ctx: any) => {
  const {
    zoom,
    renderZoom,
    tracks,
    mixtapeMixMode,
    mixtapeStemMode,
    t,
    libraryUtils,
    waveformDataMap,
    rawWaveformDataMap,
    waveformInflight,
    rawWaveformInflight,
    waveformMinMaxCache,
    rawWaveformPyramidMap,
    timelineLayoutCache,
    timelineLayoutVersion,
    waveformVersion,
    overviewWidth,
    timelineVisualScale,
    waveformTileCache,
    waveformTileCacheIndex,
    waveformTileCacheTickRef,
    waveformTileCacheLimitRef
  } = ctx

  const getWaveformTileCacheTick = () => Number(waveformTileCacheTickRef.value || 0)
  const setWaveformTileCacheTick = (value: number) => {
    waveformTileCacheTickRef.value = value
  }
  const getWaveformTileCacheLimit = () => Number(waveformTileCacheLimitRef.value || 0)

  const clampZoomValue = (value: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value))

  const buildZoomLevels = () => {
    const levels: number[] = []
    const min = ZOOM_MIN
    const max = ZOOM_MAX
    const step = RENDER_ZOOM_STEP
    const extra = min + step / 2
    const pushLevel = (value: number) => {
      if (value < min - 0.0001 || value > max + 0.0001) return
      const rounded = Number(value.toFixed(3))
      if (levels.some((item) => Math.abs(item - rounded) < 0.0001)) return
      levels.push(rounded)
    }
    pushLevel(min)
    if (extra > min && extra < min + step - 0.0001) pushLevel(extra)
    for (let cursor = min + step; cursor <= max + 0.0001; cursor += step) {
      pushLevel(cursor)
    }
    pushLevel(max)
    levels.sort((a, b) => a - b)
    return levels
  }

  const ZOOM_LEVELS = buildZoomLevels()

  const quantizeRenderZoom = (value: number) => {
    const clamped = clampZoomValue(value)
    if (!ZOOM_LEVELS.length) return clamped
    let nearest = ZOOM_LEVELS[0]
    let bestDiff = Math.abs(clamped - nearest)
    for (let i = 1; i < ZOOM_LEVELS.length; i += 1) {
      const candidate = ZOOM_LEVELS[i]
      const diff = Math.abs(clamped - candidate)
      if (diff < bestDiff) {
        bestDiff = diff
        nearest = candidate
      }
    }
    return clampZoomValue(Number(nearest.toFixed(3)))
  }

  const normalizedZoom = computed(() => {
    const value = Number.isFinite(zoom.value) ? zoom.value : 1
    return clampZoomValue(value)
  })

  const normalizedRenderZoom = computed(() => {
    const value = Number.isFinite(renderZoom.value) ? renderZoom.value : normalizedZoom.value
    return clampZoomValue(value)
  })

  const resolveRenderZoomLevel = (value: number) => quantizeRenderZoom(value)

  const alignZoomToRenderLevel = (value: number) => resolveRenderZoomLevel(value)

  const resolveGridBarWidth = (zoomValue: number) => {
    const safeZoom = Number.isFinite(zoomValue) ? zoomValue : 1
    const minZoom = ZOOM_MIN
    const maxZoom = GRID_BAR_WIDTH_MAX_ZOOM
    if (safeZoom <= minZoom) return GRID_BAR_WIDTH_MIN
    if (safeZoom >= maxZoom) return GRID_BAR_WIDTH_MAX
    const ratio = (safeZoom - minZoom) / Math.max(0.0001, maxZoom - minZoom)
    return GRID_BAR_WIDTH_MIN + (GRID_BAR_WIDTH_MAX - GRID_BAR_WIDTH_MIN) * ratio
  }

  const resolveTimelineVisualScale = () => {
    const numeric = Number(timelineVisualScale?.value)
    if (!Number.isFinite(numeric) || numeric <= 0) return 1
    return Math.max(1, numeric)
  }

  const resolveLaneHeightForZoom = (_value: number) =>
    Math.round(MIXTAPE_BASE_TRACK_LANE_HEIGHT * resolveTimelineVisualScale())

  const resolveTimelineBufferId = (zoomValue: number) => `z:${Math.round(zoomValue * 1000)}`

  const laneHeight = computed(() => resolveLaneHeightForZoom(normalizedRenderZoom.value))

  const laneIndices = Array.from({ length: LANE_COUNT }, (_, index) => index)
  const STEM_IDS_4STEMS: MixtapeWaveformStemId[] = ['vocal', 'inst', 'bass', 'drums']
  const isStemMixMode = (): boolean =>
    (mixtapeMixMode?.value as MixtapeMixMode | undefined) !== 'eq'

  const resolveWaveformStemIds = (): MixtapeWaveformStemId[] => STEM_IDS_4STEMS

  const resolveTrackStemFilePath = (track: MixtapeTrack, stemId: MixtapeWaveformStemId): string => {
    if (stemId === 'vocal') return String(track.stemVocalPath || '').trim()
    if (stemId === 'inst') return String(track.stemInstPath || '').trim()
    if (stemId === 'bass') return String(track.stemBassPath || '').trim()
    return String(track.stemDrumsPath || '').trim()
  }

  const resolveWaveformSubLaneMetrics = (
    laneHeightValue: number,
    laneIndexValue: number,
    laneCountValue: number
  ) => {
    const safeHeight = Math.max(1, Math.round(Number(laneHeightValue) || 0))
    const safeCount = Math.max(1, Math.floor(Number(laneCountValue) || 1))
    const safeIndex = Math.max(0, Math.min(safeCount - 1, Math.floor(Number(laneIndexValue) || 0)))
    const start = Math.floor((safeHeight * safeIndex) / safeCount)
    const end = Math.floor((safeHeight * (safeIndex + 1)) / safeCount)
    return {
      offset: start,
      height: Math.max(1, end - start)
    }
  }

  const resolveTrackTitle = (track: MixtapeTrack) => {
    const title = String(track?.title || '').trim()
    if (title) return title
    const filePath = String(track?.filePath || '')
    if (!filePath) return ''
    return filePath.split(/[\\/]/).pop() || filePath
  }

  const formatTrackBpm = (value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A'
    return value.toFixed(3).replace(/\.?0+$/, '')
  }

  const useHalfWaveform = () => false

  const resolveRenderPxPerSec = (value: number) =>
    BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE * clampZoomValue(value)

  const pxPerSec = computed(() => resolveRenderPxPerSec(normalizedZoom.value))

  const renderPxPerSec = computed(() => resolveRenderPxPerSec(normalizedRenderZoom.value))

  const useRawWaveform = computed(() => normalizedZoom.value >= RAW_WAVEFORM_MIN_ZOOM)

  const parseDurationToSeconds = (input: string) => {
    if (!input) return 0
    const parts = String(input)
      .trim()
      .split(':')
      .map((part) => Number(part))
      .filter((value) => Number.isFinite(value))
    if (!parts.length) return 0
    if (parts.length === 1) return Math.max(0, parts[0])
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1])
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2])
  }

  const resolveValidBpm = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return numeric
  }

  const normalizeBeatOffset = (value: number, interval: number) => {
    return normalizeBeatOffsetByMixxx(value, interval)
  }

  const resolveTrackTempoRatio = (track: MixtapeTrack, targetBpm?: number) => {
    const target = resolveValidBpm(targetBpm ?? track.bpm)
    const original = resolveValidBpm(track.originalBpm)
    if (!target || !original) return 1
    return resolveTempoRatioByBpm(target, original)
  }

  const resolveTrackFirstBeatSeconds = (track: MixtapeTrack, targetBpm?: number) => {
    const ratio = resolveTrackTempoRatio(track, targetBpm)
    return resolveFirstBeatTimelineSec(track.firstBeatMs, ratio)
  }

  const resolveTrackFirstBeatMs = (track: MixtapeTrack, targetBpm?: number) => {
    const firstBeatSec = resolveTrackFirstBeatSeconds(track, targetBpm)
    if (!Number.isFinite(firstBeatSec) || firstBeatSec <= 0) return 0
    return firstBeatSec * 1000
  }

  const resolveTrackSourceDurationSeconds = (track: MixtapeTrack) => {
    void waveformVersion?.value
    const candidateFilePaths = [
      ...(isStemMixMode()
        ? resolveWaveformStemIds()
            .map((stemId) => resolveTrackStemFilePath(track, stemId))
            .filter(Boolean)
        : []),
      ...[String(track.filePath || '').trim()].filter(Boolean)
    ]
    for (const filePath of candidateFilePaths) {
      const data = waveformDataMap.get(filePath) || null
      if (data && Number.isFinite(data.duration) && data.duration > 0) {
        return data.duration
      }
      const rawData = rawWaveformDataMap.get(filePath) || null
      if (rawData && Number.isFinite(rawData.duration) && rawData.duration > 0) {
        return rawData.duration
      }
    }
    return parseDurationToSeconds(track.duration)
  }

  const resolveTrackDurationSeconds = (track: MixtapeTrack) => {
    void waveformVersion?.value
    const sourceDuration = resolveTrackSourceDurationSeconds(track)
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return 0
    if (Array.isArray(track.bpmEnvelope) && track.bpmEnvelope.length >= 2) {
      const fallbackRatio = resolveTrackTempoRatio(track)
      const fallbackDuration =
        Number.isFinite(fallbackRatio) && fallbackRatio > 0
          ? sourceDuration / fallbackRatio
          : sourceDuration
      return resolveTrackTimelineDurationFromSource({
        rawPoints: track.bpmEnvelope,
        sourceDurationSec: sourceDuration,
        originalBpm: Number(track.originalBpm) || Number(track.bpm) || 0,
        fallbackBpm: resolveTrackBpmEnvelopeBaseValue(track),
        fallbackDurationSec: fallbackDuration
      })
    }
    const ratio = resolveTrackTempoRatio(track)
    if (!Number.isFinite(ratio) || ratio <= 0) return sourceDuration
    return sourceDuration / ratio
  }

  const resolveTrackRenderWidthPx = (track: MixtapeTrack, zoomValue?: number) => {
    const duration = resolveTrackDurationSeconds(track)
    if (!duration || !Number.isFinite(duration)) return FALLBACK_TRACK_WIDTH
    const px = resolveRenderPxPerSec(
      typeof zoomValue === 'number' ? zoomValue : normalizedRenderZoom.value
    )
    return Math.max(MIN_TRACK_WIDTH, Math.round(duration * px))
  }

  const clearTimelineLayoutCache = () => {
    timelineLayoutCache.clear()
    if (timelineLayoutVersion && typeof timelineLayoutVersion.value === 'number') {
      timelineLayoutVersion.value += 1
    }
  }

  const resolveFirstVisibleLayoutIndex = (endOffsets: number[], minX: number) => {
    if (!endOffsets.length) return -1
    let left = 0
    let right = endOffsets.length - 1
    let answer = -1
    while (left <= right) {
      const middle = (left + right) >> 1
      const endX = endOffsets[middle] || 0
      if (endX >= minX) {
        answer = middle
        right = middle - 1
      } else {
        left = middle + 1
      }
    }
    return answer
  }

  const forEachVisibleLayoutItem = (
    snapshot: TimelineLayoutSnapshot,
    visibleStart: number,
    visibleEnd: number,
    visitor: (item: TimelineTrackLayout) => void
  ) => {
    if (!snapshot.layout.length) return
    if (visibleEnd < visibleStart) return
    const first = resolveFirstVisibleLayoutIndex(snapshot.endOffsets, visibleStart)
    if (first < 0) return
    for (let index = first; index < snapshot.layout.length; index += 1) {
      const startX = snapshot.startOffsets[index] || 0
      if (startX > visibleEnd) break
      const item = snapshot.layout[index]
      if (!item) continue
      visitor(item)
    }
  }

  const buildSequentialLayoutForZoom = (zoomValue: number): TimelineLayoutSnapshot => {
    const resolvedZoom = resolveRenderZoomLevel(zoomValue)
    const cacheKey = Math.round(resolvedZoom * 1000)
    const cached = timelineLayoutCache.get(cacheKey)
    if (cached) return cached

    const px = resolveRenderPxPerSec(resolvedZoom)
    let cursorPx = TIMELINE_SIDE_PADDING_PX
    let cursorSec = 0
    const layout: TimelineTrackLayout[] = []

    for (let i = 0; i < tracks.value.length; i += 1) {
      const track = tracks.value[i]
      if (!track) continue
      const width = resolveTrackRenderWidthPx(track, resolvedZoom)
      const durationSec = resolveTrackDurationSeconds(track)
      const rawStartSec = Number(track.startSec)
      const startSec =
        Number.isFinite(rawStartSec) && rawStartSec >= 0 ? Math.max(0, rawStartSec) : cursorSec
      const startX = TIMELINE_SIDE_PADDING_PX + Math.round(startSec * px)
      const endX = startX + width
      cursorPx = Math.max(cursorPx, endX)
      if (Number.isFinite(durationSec) && durationSec > 0) {
        cursorSec = Math.max(cursorSec, startSec + durationSec)
      } else {
        cursorSec = Math.max(cursorSec, endX / Math.max(0.0001, px))
      }
      layout.push({
        track,
        laneIndex: i % LANE_COUNT,
        startSec,
        startX,
        width
      })
    }

    layout.sort((a, b) => a.startX - b.startX)
    const startOffsets: number[] = []
    const endOffsets: number[] = []
    let runningEnd = 0
    for (const item of layout) {
      startOffsets.push(item.startX)
      runningEnd = Math.max(runningEnd, item.startX + item.width)
      endOffsets.push(runningEnd)
    }
    const lastEnd = endOffsets[endOffsets.length - 1] || 0

    const timelineEndX = Math.max(cursorPx, lastEnd)
    const snapshot = {
      layout,
      totalWidth: Math.max(TIMELINE_SIDE_PADDING_PX * 2, timelineEndX + TIMELINE_SIDE_PADDING_PX),
      startOffsets,
      endOffsets
    }
    timelineLayoutCache.set(cacheKey, snapshot)
    return snapshot
  }

  const resolveTrackBlockStyle = (item: TimelineTrackLayout) => ({
    width: `${Math.max(0, Math.round(item.width))}px`,
    left: `${Math.round(item.startX)}px`,
    '--track-start': `${Math.round(item.startX)}px`
  })

  const resolveGainEnvelopePolyline = (item: TimelineTrackLayout) => {
    const currentTrack =
      tracks.value.find((track: MixtapeTrack) => track.id === item.track.id) || item.track
    const trackDurationSec = resolveTrackDurationSeconds(currentTrack)
    const safeDuration = Math.max(0, Number(trackDurationSec) || 0)
    const envelope = normalizeGainEnvelopePoints(currentTrack.gainEnvelope, safeDuration)
    return buildGainEnvelopePolylineByControlPoints({
      points: envelope,
      durationSec: safeDuration,
      minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
      maxDb: MIXTAPE_GAIN_KNOB_MAX_DB
    })
  }

  const resolveOverviewScale = () => {
    const width = overviewWidth.value
    const totalWidth = Math.max(
      1,
      buildSequentialLayoutForZoom(normalizedRenderZoom.value).totalWidth
    )
    if (!Number.isFinite(width) || width <= 0) return 1
    return width / totalWidth
  }

  const resolveOverviewTrackStyle = (item: TimelineTrackLayout) => {
    const scale = resolveOverviewScale()
    return {
      width: `${Math.max(1, Math.round(item.width * scale))}px`,
      transform: `translate3d(${Math.round(item.startX * scale)}px, 0, 0)`
    }
  }

  const resolveTrackTilesForWidth = (trackWidth: number): WaveformTile[] => {
    if (!trackWidth || !Number.isFinite(trackWidth)) return []
    const count = Math.max(1, Math.ceil(trackWidth / WAVEFORM_TILE_WIDTH))
    const tiles: WaveformTile[] = []
    for (let i = 0; i < count; i += 1) {
      const start = i * WAVEFORM_TILE_WIDTH
      const width = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, trackWidth - start))
      if (width <= 0) continue
      tiles.push({ index: i, start, width })
    }
    return tiles
  }

  const drawTrackGridLines = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    track: MixtapeTrack,
    durationSec: number,
    trackWidth: number,
    barBeatOffset: number,
    range: { start: number; end: number },
    barOnly: boolean,
    zoomValue: number
  ) => {
    const safeDurationSec = Math.max(0, Number(durationSec) || 0)
    const safeTrackWidth = Math.max(0, Number(trackWidth) || 0)
    if (safeDurationSec <= 0) return
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const bpmEnvelope = normalizeTrackBpmEnvelopePoints(track.bpmEnvelope, safeDurationSec, baseBpm)
    const sourceDurationSec = Math.max(0, Number(resolveTrackSourceDurationSeconds(track)) || 0)
    const visibleGridLines = buildTrackVisibleGridLines({
      points: bpmEnvelope,
      durationSec: safeDurationSec,
      sourceDurationSec,
      firstBeatSourceSec: Math.max(0, Number(track.firstBeatMs) || 0) / 1000,
      beatSourceSec: 60 / Math.max(1, resolveTrackGridSourceBpm(track)),
      barBeatOffset,
      zoom: zoomValue,
      originalBpm: Number(track.originalBpm) || Number(track.bpm) || 0,
      fallbackBpm: baseBpm
    })
    if (!visibleGridLines.length) return

    const startX = range.start
    const endX = range.end
    if (endX <= startX || width <= 0 || height <= 0) return

    const barWidth = resolveGridBarWidth(zoomValue)

    context.save()
    for (const line of visibleGridLines) {
      const rawX = (line.sec / safeDurationSec) * safeTrackWidth
      if (rawX < startX - 64 || rawX > endX + 64) continue
      if (barOnly && line.level !== 'bar') continue
      const x = Math.round(rawX - startX)

      if (line.level === 'bar') {
        context.globalAlpha = 0.95
        context.fillStyle = 'rgba(0, 110, 220, 0.98)'
        context.fillRect(x, 0, barWidth, height)
      } else if (line.level === 'beat4') {
        context.globalAlpha = 0.85
        context.fillStyle = 'rgba(120, 200, 255, 0.98)'
        context.fillRect(x, 0, 1.8, height)
      } else {
        context.globalAlpha = 0.8
        context.fillStyle = 'rgba(180, 225, 255, 0.95)'
        context.fillRect(x, 0, 1.3, height)
      }
    }
    context.restore()
  }

  const resolveWaveformListRoot = (track: MixtapeTrack) => {
    const originUuid = track.originPlaylistUuid
    if (!originUuid) return ''
    return libraryUtils.findDirPathByUuid(originUuid) || ''
  }

  const resolveTrackWaveformSources = (track: MixtapeTrack): TrackWaveformSource[] => {
    const listRoot = resolveWaveformListRoot(track)
    if (!isStemMixMode()) {
      const filePath = String(track.filePath || '').trim()
      if (!filePath) return []
      return [
        {
          filePath,
          listRoot,
          laneIndex: 0,
          laneCount: 1,
          stemId: 'inst'
        }
      ]
    }
    const stemIds = resolveWaveformStemIds()
    const stemSources: Array<{ stemId: MixtapeWaveformStemId; filePath: string }> = []
    for (const stemId of stemIds) {
      const filePath = resolveTrackStemFilePath(track, stemId)
      if (!filePath) return []
      stemSources.push({ stemId, filePath })
    }
    const laneCount = stemSources.length
    return stemSources.map((item, laneIndex) => ({
      filePath: item.filePath,
      listRoot,
      laneIndex,
      laneCount,
      stemId: item.stemId
    }))
  }

  const resolveTrackWaveformFilePaths = (track: MixtapeTrack) =>
    Array.from(new Set(resolveTrackWaveformSources(track).map((item) => item.filePath)))

  const isWaveformReady = (track: MixtapeTrack) => {
    void waveformVersion?.value
    const sources = resolveTrackWaveformSources(track)
    if (!sources.length) return false
    for (const source of sources) {
      const filePath = source.filePath
      if (!filePath) return false
      if (waveformInflight.has(filePath)) return false
      const waveformData = waveformDataMap.get(filePath)
      if (waveformData) continue
      const rawData = rawWaveformDataMap.get(filePath)
      if (rawData) continue
      return false
    }
    return true
  }

  const isRawWaveformLoading = (track: MixtapeTrack) => {
    void waveformVersion?.value
    if (!useRawWaveform.value) return false
    const sources = resolveTrackWaveformSources(track)
    if (!sources.length) return false
    for (const source of sources) {
      const filePath = source.filePath
      if (!filePath) continue
      if (rawWaveformInflight.has(filePath)) return true
      if (!rawWaveformDataMap.has(filePath)) return true
    }
    return false
  }

  const resolveWaveformTitle = (track: MixtapeTrack) => {
    if (isWaveformReady(track)) return resolveTrackTitle(track)
    const loading = typeof t === 'function' ? t('mixtape.waveformLoading') : ''
    const base = resolveTrackTitle(track)
    return loading ? `${base} ${loading}` : base
  }

  const computeTimelineDuration = () => {
    void waveformVersion?.value
    let cursor = 0
    let maxEnd = 0
    for (const track of tracks.value) {
      const duration = resolveTrackDurationSeconds(track)
      if (!Number.isFinite(duration) || duration <= 0) continue
      const startSec = Number(track.startSec)
      const start =
        Number.isFinite(startSec) && startSec >= 0 ? Math.max(0, startSec) : Math.max(0, cursor)
      const end = start + duration
      maxEnd = Math.max(maxEnd, end)
      cursor = Math.max(cursor, end)
    }
    return maxEnd
  }

  const buildMinMaxDataFromStemWaveform = (waveformData: StemWaveformData): MinMaxSample[] => {
    const all = waveformData.all
    const frameCount = Math.min(all.left.length, all.right.length)
    if (!frameCount) return []

    const samples = new Array<MinMaxSample>(frameCount)
    for (let i = 0; i < frameCount; i += 1) {
      const leftPeak = all.peakLeft ? all.peakLeft[i] : all.left[i]
      const rightPeak = all.peakRight ? all.peakRight[i] : all.right[i]
      const leftAmp = Math.min(1, leftPeak / 255)
      const rightAmp = Math.min(1, rightPeak / 255)
      samples[i] = { min: -rightAmp, max: leftAmp }
    }
    return samples
  }

  const buildMinMaxDataFromMixxxWaveform = (waveformData: MixxxWaveformData): MinMaxSample[] => {
    const low = waveformData.bands.low
    const mid = waveformData.bands.mid
    const high = waveformData.bands.high
    const frameCount = Math.min(
      low.left.length,
      low.right.length,
      mid.left.length,
      mid.right.length,
      high.left.length,
      high.right.length
    )
    if (!frameCount) return []

    const samples = new Array<MinMaxSample>(frameCount)
    for (let i = 0; i < frameCount; i += 1) {
      const lowLeft = low.peakLeft ? low.peakLeft[i] : low.left[i]
      const lowRight = low.peakRight ? low.peakRight[i] : low.right[i]
      const midLeft = mid.peakLeft ? mid.peakLeft[i] : mid.left[i]
      const midRight = mid.peakRight ? mid.peakRight[i] : mid.right[i]
      const highLeft = high.peakLeft ? high.peakLeft[i] : high.left[i]
      const highRight = high.peakRight ? high.peakRight[i] : high.right[i]
      const leftEnergy = Math.sqrt(lowLeft * lowLeft + midLeft * midLeft + highLeft * highLeft)
      const rightEnergy = Math.sqrt(
        lowRight * lowRight + midRight * midRight + highRight * highRight
      )
      const leftAmp = Math.min(1, leftEnergy / MIXXX_MAX_RGB_ENERGY)
      const rightAmp = Math.min(1, rightEnergy / MIXXX_MAX_RGB_ENERGY)
      samples[i] = { min: -rightAmp, max: leftAmp }
    }
    return samples
  }

  const isValidStemWaveformData = (data: unknown): data is StemWaveformData => {
    if (!data || typeof data !== 'object') return false
    const all = (data as StemWaveformData).all
    if (!all) return false
    const frameCount =
      all.left?.length || all.right?.length || all.peakLeft?.length || all.peakRight?.length || 0
    if (!frameCount) return false
    const isMatch = (arr?: Uint8Array) => (arr ? arr.length === frameCount : true)
    return (
      isMatch(all.left) && isMatch(all.right) && isMatch(all.peakLeft) && isMatch(all.peakRight)
    )
  }

  const isValidMixxxWaveformData = (data: unknown): data is MixxxWaveformData => {
    if (!data || typeof data !== 'object') return false
    const bands = (data as MixxxWaveformData).bands
    const low = bands?.low
    const mid = bands?.mid
    const high = bands?.high
    const all = bands?.all
    if (!low || !mid || !high || !all) return false
    const frameCount =
      low.left?.length || low.right?.length || low.peakLeft?.length || low.peakRight?.length || 0
    if (!frameCount) return false
    const isMatch = (arr?: Uint8Array) => (arr ? arr.length === frameCount : true)
    return (
      isMatch(low.left) &&
      isMatch(low.right) &&
      isMatch(low.peakLeft) &&
      isMatch(low.peakRight) &&
      isMatch(mid.left) &&
      isMatch(mid.right) &&
      isMatch(mid.peakLeft) &&
      isMatch(mid.peakRight) &&
      isMatch(high.left) &&
      isMatch(high.right) &&
      isMatch(high.peakLeft) &&
      isMatch(high.peakRight) &&
      isMatch(all.left) &&
      isMatch(all.right) &&
      isMatch(all.peakLeft) &&
      isMatch(all.peakRight)
    )
  }

  const isValidWaveformData = (
    data: StemWaveformData | MixxxWaveformData | null
  ): data is StemWaveformData | MixxxWaveformData => {
    if (!data) return false
    if (isValidStemWaveformData(data)) return true
    if (isValidMixxxWaveformData(data)) return true
    return false
  }

  const getMinMaxSamples = (
    filePath: string,
    data: StemWaveformData | MixxxWaveformData
  ): MinMaxSample[] => {
    const cached = waveformMinMaxCache.get(filePath)
    if (cached && cached.source === data) return cached.samples
    const samples = isValidStemWaveformData(data)
      ? buildMinMaxDataFromStemWaveform(data)
      : buildMinMaxDataFromMixxxWaveform(data)
    waveformMinMaxCache.set(filePath, { source: data, samples })
    return samples
  }

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

  const resolveRawWaveformLevel = (
    filePath: string,
    raw: RawWaveformData | null,
    samplesPerPixel: number
  ): RawWaveformData | null =>
    resolveRawWaveformLevelByMap(rawWaveformPyramidMap, filePath, raw, samplesPerPixel)

  const buildWaveformTileCacheKey = (
    filePath: string,
    stemId: MixtapeWaveformStemId,
    tileIndex: number,
    zoomValue: number,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const zoomKey = Math.round(zoomValue * 1000)
    const ratioKey = Math.round(pixelRatio * 100)
    const waveformHeightScaleKey = Math.round(MIXTAPE_WAVEFORM_HEIGHT_SCALE * 1000)
    return `${filePath}::${stemId}::${tileIndex}::${zoomKey}::${width}x${height}@${ratioKey}::h${waveformHeightScaleKey}`
  }

  const touchWaveformTileCache = (key: string) => {
    const entry = waveformTileCache.get(key)
    if (!entry) return
    const tick = getWaveformTileCacheTick() + 1
    setWaveformTileCacheTick(tick)
    entry.used = tick
  }

  const registerWaveformTileCacheKey = (filePath: string, key: string) => {
    const set = waveformTileCacheIndex.get(filePath) || new Set<string>()
    set.add(key)
    waveformTileCacheIndex.set(filePath, set)
  }

  const disposeWaveformCacheEntry = (
    entry?: { source: CanvasImageSource; used: number } | null
  ) => {
    if (!entry) return
    const source = entry.source as ImageBitmap | null
    if (source && typeof source.close === 'function') {
      source.close()
    }
  }

  const pruneWaveformTileCache = () => {
    const cacheLimit = getWaveformTileCacheLimit()
    if (waveformTileCache.size <= cacheLimit) return

    const entries = Array.from(waveformTileCache.entries()) as Array<
      [string, { source: CanvasImageSource; used: number }]
    >
    entries.sort((a, b) => a[1].used - b[1].used)
    const removeCount = Math.max(0, waveformTileCache.size - cacheLimit)

    for (let i = 0; i < removeCount; i += 1) {
      const [key] = entries[i]
      const entry = waveformTileCache.get(key)
      disposeWaveformCacheEntry(entry || null)
      waveformTileCache.delete(key)

      const filePath = key.split('::')[0] || ''
      if (!filePath) continue
      const set = waveformTileCacheIndex.get(filePath)
      if (!set) continue
      set.delete(key)
      if (!set.size) {
        waveformTileCacheIndex.delete(filePath)
      }
    }
  }

  return {
    clampZoomValue,
    buildZoomLevels,
    quantizeRenderZoom,
    normalizedZoom,
    normalizedRenderZoom,
    resolveRenderZoomLevel,
    alignZoomToRenderLevel,
    resolveGridBarWidth,
    resolveLaneHeightForZoom,
    resolveTimelineBufferId,
    laneHeight,
    laneIndices,
    resolveTrackTitle,
    formatTrackBpm,
    useHalfWaveform,
    resolveRenderPxPerSec,
    pxPerSec,
    renderPxPerSec,
    useRawWaveform,
    parseDurationToSeconds,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    resolveTrackFirstBeatMs,
    resolveTrackRenderWidthPx,
    clearTimelineLayoutCache,
    resolveFirstVisibleLayoutIndex,
    forEachVisibleLayoutItem,
    buildSequentialLayoutForZoom,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveOverviewTrackStyle,
    resolveTrackTilesForWidth,
    drawTrackGridLines,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    resolveTrackWaveformFilePaths,
    resolveWaveformSubLaneMetrics,
    isWaveformReady,
    isRawWaveformLoading,
    resolveWaveformTitle,
    computeTimelineDuration,
    buildMinMaxDataFromStemWaveform,
    isValidWaveformData,
    getMinMaxSamples,
    decodeRawFloatArray,
    decodeRawWaveformData,
    resolveRawWaveformLevel,
    buildWaveformTileCacheKey,
    touchWaveformTileCache,
    registerWaveformTileCacheKey,
    disposeWaveformCacheEntry,
    pruneWaveformTileCache
  }
}
