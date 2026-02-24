import { computed, ref } from 'vue'
import { t } from '@renderer/utils/translate'
import { canPlayHtmlAudio, toPreviewUrl } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import {
  GRID_BEAT4_LINE_ZOOM,
  GRID_BEAT_LINE_ZOOM,
  LANE_COUNT,
  TIMELINE_SIDE_PADDING_PX
} from '@renderer/composables/mixtape/constants'
import {
  normalizeBeatOffset as normalizeBeatOffsetByMixxx,
  resolveBeatSecByBpm,
  resolveFirstBeatTimelineSec,
  resolveGridAnchorSec
} from '@renderer/composables/mixtape/mixxxSyncModel'
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
import { applyMixxxTransportSync } from '@renderer/composables/mixtape/timelineTransportSync'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

// ── PCM 数据归一化（仅用于 IPC 解码路径）───────────────────────
const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

// ── Transport 条目类型 ──────────────────────────────────────────
type TransportEntry = {
  trackId: string
  filePath: string
  startSec: number
  bpm: number
  beatSec: number
  firstBeatSec: number
  barBeatOffset: number
  masterTempo: boolean
  syncAnchorSec: number
  sourceDuration: number
  duration: number
  tempoRatio: number
  mixEnvelopes: Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>
  mixEnvelopeSources: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
  volumeMuteSegments: MixtapeMuteSegment[]
  volumeMuteSegmentsSource?: MixtapeMuteSegment[]
  /** 解码策略：browser = fetch + decodeAudioData（快）；ipc = 主进程 Rust/FFmpeg 解码 */
  decodeMode: 'browser' | 'ipc'
  /** 解码后的 AudioBuffer */
  audioBuffer: AudioBuffer | null
}

// ── 单轨音频图节点（Phase 1 基础图：Source → Gain → destination）
type TrackGraphNode = {
  trackId: string
  entry: TransportEntry
  source: AudioBufferSourceNode
  eqHigh: BiquadFilterNode
  eqMid: BiquadFilterNode
  eqLow: BiquadFilterNode
  volume: GainNode
  gain: GainNode
}

const MIX_ENVELOPE_PARAMS: MixtapeEnvelopeParamId[] = ['gain', 'high', 'mid', 'low', 'volume']
const MIXTAPE_SEGMENT_MUTE_GAIN = 0.0001

export const createTimelineTransportAndDragModule = (ctx: any) => {
  const {
    tracks,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollLeft,
    timelineViewportWidth,
    buildSequentialLayoutForZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    computeTimelineDuration,
    scheduleFullPreRender,
    scheduleWorkerPreRender
  } = ctx

  const isTrackDragging = ref(false)
  const transportPlaying = ref(false)
  const transportDecoding = ref(false)
  const transportPreloading = ref(false)
  const transportPreloadDone = ref(0)
  const transportPreloadTotal = ref(0)
  const transportPreloadFailed = ref(0)
  const playheadSec = ref(0)
  const playheadVisible = ref(false)
  const transportError = ref('')

  let transportRaf = 0
  let transportBaseSec = 0
  let transportStartedAt = 0
  let transportAudioStartAt = 0
  let transportDurationSec = 0
  let transportPreloadTimer: ReturnType<typeof setTimeout> | null = null
  // 共享 AudioContext（贯穿整个混音 transport 生命周期）
  let transportAudioCtx: AudioContext | null = null
  // 当前活跃的音频图节点列表
  let transportGraphNodes: TrackGraphNode[] = []
  let transportMasterTrackId = ''
  // 版本号，用于取消过期的异步解码操作
  let transportVersion = 0
  let transportPreloadVersion = 0
  // 已解码 AudioBuffer 缓存（窗口级），避免时间轴点击反复解码
  const transportDecodedBufferCache = new Map<string, AudioBuffer>()
  // 进行中的解码任务（按 filePath 复用 Promise）
  const transportDecodeInflight = new Map<string, Promise<AudioBuffer>>()

  let trackDragState: {
    trackId: string
    startClientX: number
    initialStartSec: number
    previousTrackId: string
    snapshotTracks: MixtapeTrack[]
  } | null = null

  const clampNumber = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value))
  const normalizeBeatOffset = (value: unknown, interval: number) => {
    return normalizeBeatOffsetByMixxx(value, interval)
  }
  const normalizeStartSec = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0) return null
    return Number(numeric.toFixed(4))
  }

  const persistTrackStartSec = async (
    entries: Array<{
      itemId: string
      startSec?: number
      bpm?: number
      masterTempo?: boolean
      originalBpm?: number
    }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-track-start-sec', { entries })
    } catch (error) {
      console.error('[mixtape] update track timing failed', {
        count: entries.length,
        error
      })
    }
  }

  const persistTrackVolumeMuteSegments = async (
    entries: Array<{ itemId: string; segments: MixtapeMuteSegment[] }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
        entries: entries.map((item) => ({
          itemId: item.itemId,
          segments: item.segments.map((segment) => ({
            startSec: Number(segment.startSec),
            endSec: Number(segment.endSec)
          }))
        }))
      })
    } catch (error) {
      console.error('[mixtape] update volume mute segments failed', {
        count: entries.length,
        error
      })
    }
  }

  const resolveTrackDurationByBpm = (track: MixtapeTrack, targetBpm: number) => {
    const sourceDuration = resolveTrackSourceDurationSeconds(track)
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return 0
    const tempoRatio = resolveTrackTempoRatio(track, targetBpm)
    if (!Number.isFinite(tempoRatio) || tempoRatio <= 0) return sourceDuration
    return sourceDuration / Math.max(0.01, tempoRatio)
  }

  const remapVolumeMuteSegmentsForBpm = (track: MixtapeTrack, targetBpm: number) => {
    const sourceDuration = resolveTrackDurationSeconds(track)
    const targetDuration = resolveTrackDurationByBpm(track, targetBpm)
    const sourceSegments = normalizeVolumeMuteSegments(track.volumeMuteSegments, sourceDuration)
    if (!sourceSegments.length) return [] as MixtapeMuteSegment[]
    const sourceBpm = Number(track.bpm)
    const sourceBeatSec = resolveBeatSecByBpm(sourceBpm)
    const targetBeatSec = resolveBeatSecByBpm(targetBpm)
    if (
      !Number.isFinite(sourceBeatSec) ||
      !sourceBeatSec ||
      !Number.isFinite(targetBeatSec) ||
      !targetBeatSec ||
      !targetDuration
    ) {
      return normalizeVolumeMuteSegments(sourceSegments, targetDuration || sourceDuration)
    }
    const sourceFirstBeatSec = resolveTrackFirstBeatSeconds(track, sourceBpm)
    const targetFirstBeatSec = resolveTrackFirstBeatSeconds(track, targetBpm)
    const beatSnapEpsilon = 0.0005
    const remapped = sourceSegments
      .map((segment) => {
        const startBeatRaw = (segment.startSec - sourceFirstBeatSec) / sourceBeatSec
        const endBeatRaw = (segment.endSec - sourceFirstBeatSec) / sourceBeatSec
        const startBeatNearest = Math.round(startBeatRaw)
        const endBeatNearest = Math.round(endBeatRaw)
        const startBeat =
          Math.abs(startBeatRaw - startBeatNearest) <= beatSnapEpsilon
            ? startBeatNearest
            : startBeatRaw
        const endBeat =
          Math.abs(endBeatRaw - endBeatNearest) <= beatSnapEpsilon ? endBeatNearest : endBeatRaw
        const remappedStart = clampNumber(
          targetFirstBeatSec + startBeat * targetBeatSec,
          0,
          targetDuration
        )
        const remappedEnd = clampNumber(
          targetFirstBeatSec + endBeat * targetBeatSec,
          0,
          targetDuration
        )
        if (remappedEnd - remappedStart <= 0.0001) return null
        return {
          startSec: Number(remappedStart.toFixed(4)),
          endSec: Number(remappedEnd.toFixed(4))
        }
      })
      .filter((segment): segment is MixtapeMuteSegment => segment !== null)
    return normalizeVolumeMuteSegments(remapped, targetDuration)
  }

  const readTransportBufferCache = (filePath: string): AudioBuffer | null => {
    const key = String(filePath || '').trim()
    if (!key) return null
    const cached = transportDecodedBufferCache.get(key) || null
    if (!cached) return null
    // LRU 触摸
    transportDecodedBufferCache.delete(key)
    transportDecodedBufferCache.set(key, cached)
    return cached
  }

  const writeTransportBufferCache = (filePath: string, buffer: AudioBuffer) => {
    const key = String(filePath || '').trim()
    if (!key || !buffer) return
    if (transportDecodedBufferCache.has(key)) {
      transportDecodedBufferCache.delete(key)
    }
    transportDecodedBufferCache.set(key, buffer)
  }

  const clearTransportPreloadTimer = () => {
    if (!transportPreloadTimer) return
    clearTimeout(transportPreloadTimer)
    transportPreloadTimer = null
  }

  const cancelTransportPreload = () => {
    transportPreloadVersion += 1
    transportPreloading.value = false
    clearTransportPreloadTimer()
  }

  // ── Computed 属性 ─────────────────────────────────────────────
  const timelineDurationSec = computed(() => computeTimelineDuration())
  const transportPreloadPercent = computed(() => {
    const total = Math.max(0, Number(transportPreloadTotal.value) || 0)
    const done = Math.max(0, Number(transportPreloadDone.value) || 0)
    if (!total) return 0
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
  })
  const resolveTimelineDisplayX = (sec: number, pxPerSec: number, maxX: number) => {
    const safeSec = Math.max(0, Number(sec) || 0)
    return clampNumber(TIMELINE_SIDE_PADDING_PX + safeSec * pxPerSec, 0, maxX)
  }
  const resolveTimelineSecByX = (x: number, pxPerSec: number) => {
    if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return 0
    const normalizedX = Math.max(0, Number(x) || 0)
    const sec = (normalizedX - TIMELINE_SIDE_PADDING_PX) / pxPerSec
    return Math.max(0, sec)
  }
  const overviewPlayheadStyle = computed(() => ({
    left: (() => {
      const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
      const totalWidth = Math.max(1, timelineLayout.value.totalWidth)
      const playheadX = resolveTimelineDisplayX(playheadSec.value, pxPerSec, totalWidth)
      return `${((playheadX / totalWidth) * 100).toFixed(4)}%`
    })()
  }))
  const rulerPlayheadStyle = computed(() => {
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalWidth = Math.max(1, timelineLayout.value.totalWidth)
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || totalWidth)
    const maxScroll = Math.max(0, totalWidth - viewportWidth)
    const viewportStartX = clampNumber(Number(timelineScrollLeft.value) || 0, 0, maxScroll)
    const playheadX = resolveTimelineDisplayX(playheadSec.value, pxPerSec, totalWidth)
    const ratio = (playheadX - viewportStartX) / viewportWidth
    return {
      left: `${(ratio * 100).toFixed(4)}%`
    }
  })
  const timelinePlayheadStyle = computed(() => {
    if (!playheadVisible.value) return null
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const maxX = Math.max(0, timelineLayout.value.totalWidth)
    const playheadX = resolveTimelineDisplayX(playheadSec.value, pxPerSec, maxX)
    return {
      transform: `translate3d(${Math.round(playheadX)}px, 0, 0)`
    }
  })

  const formatTransportTime = (seconds: number) => {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
    const total = Math.floor(safe)
    const hh = Math.floor(total / 3600)
    const mm = Math.floor((total % 3600) / 60)
    const ss = total % 60
    if (hh > 0) {
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    }
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }
  const playheadTimeLabel = computed(() => {
    if (!transportPlaying.value) return '--:--:--'
    return formatTransportTime(playheadSec.value)
  })
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
    if (viewportWidth <= 0 || timelineEndSec <= 0)
      return [] as Array<{ left: string; value: number; align: RulerTickAlign }>
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

  // ── 轨道时间解析 ──────────────────────────────────────────────
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
    entry: TransportEntry,
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
    return muted ? MIXTAPE_SEGMENT_MUTE_GAIN : envelopeGain
  }

  const resolveEntryEqDbValue = (
    entry: TransportEntry,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => {
    const gain = resolveEntryEnvelopeValue(entry, param, timelineOffsetSec)
    return clampNumber(linearGainToDb(gain), MIXTAPE_GAIN_KNOB_MIN_DB, MIXTAPE_GAIN_KNOB_MAX_DB)
  }

  // ── AudioContext 管理 ─────────────────────────────────────────
  const ensureTransportAudioContext = (sampleRate?: number): AudioContext => {
    if (transportAudioCtx && transportAudioCtx.state !== 'closed') {
      return transportAudioCtx
    }
    transportAudioCtx = new AudioContext(sampleRate ? { sampleRate } : undefined)
    return transportAudioCtx
  }

  const clearTransportGraphNodes = () => {
    for (const node of transportGraphNodes) {
      try {
        node.source.stop()
      } catch {}
      try {
        node.source.disconnect()
      } catch {}
      try {
        node.eqHigh.disconnect()
      } catch {}
      try {
        node.eqMid.disconnect()
      } catch {}
      try {
        node.eqLow.disconnect()
      } catch {}
      try {
        node.volume.disconnect()
      } catch {}
      try {
        node.gain.disconnect()
      } catch {}
    }
    transportGraphNodes = []
    transportMasterTrackId = ''
  }

  const stopTransport = () => {
    transportVersion += 1
    if (transportRaf) {
      cancelAnimationFrame(transportRaf)
      transportRaf = 0
    }
    transportPlaying.value = false
    transportDecoding.value = false
    transportStartedAt = 0
    transportAudioStartAt = 0
    clearTransportGraphNodes()
  }

  const resolveTransportDuration = () => {
    const total = transportDurationSec > 0 ? transportDurationSec : timelineDurationSec.value
    if (!Number.isFinite(total) || total <= 0) return 0
    return total
  }

  const finishTransportPlayback = () => {
    const total = resolveTransportDuration()
    stopTransport()
    playheadVisible.value = false
    playheadSec.value = total
  }

  const handleTransportStop = () => {
    stopTransport()
    playheadVisible.value = false
  }

  const resolveTransportRestartSec = () => {
    const total = resolveTransportDuration()
    if (!total) return 0
    if (playheadSec.value >= total - 0.05) return 0
    return clampNumber(playheadSec.value, 0, total)
  }

  const resolveRulerSeekSec = (event: MouseEvent) => {
    const target = event.currentTarget as HTMLElement | null
    if (!target) return resolveTransportRestartSec()
    const rect = target.getBoundingClientRect()
    const rulerWidth = rect.width || 0
    if (!rulerWidth) return resolveTransportRestartSec()
    const localRatio = clampNumber((event.clientX - rect.left) / rulerWidth, 0, 1)
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    if (totalWidth <= 0) return 0
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || rulerWidth)
    const maxScroll = Math.max(0, totalWidth - viewportWidth)
    const viewportStartX = clampNumber(Number(timelineScrollLeft.value) || 0, 0, maxScroll)
    const targetX = clampNumber(viewportStartX + localRatio * viewportWidth, 0, totalWidth)
    const totalSec = Math.max(0, timelineDurationSec.value)
    const sec = resolveTimelineSecByX(targetX, pxPerSec)
    if (!Number.isFinite(sec) || sec <= 0) return 0
    return clampNumber(sec, 0, totalSec)
  }

  // ── 构建 Transport 条目（所有格式统一走后端解码）─────────────
  const buildTransportEntries = () => {
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const snapshot = buildSequentialLayoutForZoom(normalizedRenderZoom.value)
    const startSecById = new Map<string, number>()
    for (const item of snapshot.layout) {
      const layoutStartSec = Number(item.startSec)
      startSecById.set(
        item.track.id,
        Number.isFinite(layoutStartSec) && layoutStartSec >= 0
          ? layoutStartSec
          : resolveTimelineSecByX(item.startX, pxPerSec)
      )
    }
    let missingDurationCount = 0
    const entries = tracks.value
      .map((track: MixtapeTrack) => {
        const filePath = String(track.filePath || '').trim()
        if (!filePath) return null
        const sourceDuration = resolveTrackSourceDurationSeconds(track)
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
          missingDurationCount += 1
          return null
        }
        const bpm = Number(track.bpm)
        const beatSec = resolveBeatSecByBpm(bpm)
        const tempoRatio = resolveTrackTempoRatio(track)
        const duration = sourceDuration / Math.max(0.01, tempoRatio)
        const firstBeatSec = resolveFirstBeatTimelineSec(track.firstBeatMs, tempoRatio)
        const barBeatOffset = normalizeBeatOffset(track.barBeatOffset, 32)
        const masterTempo = track.masterTempo !== false
        const startSec = startSecById.get(track.id) ?? resolveTrackStartSec(track)
        const syncAnchorSec = resolveGridAnchorSec({
          startSec,
          firstBeatSec,
          beatSec,
          barBeatOffset
        })
        const mixEnvelopes = MIX_ENVELOPE_PARAMS.reduce(
          (acc, param) => {
            acc[param] = resolveTrackMixEnvelope(track, duration, param)
            return acc
          },
          {} as Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>
        )
        const mixEnvelopeSources = MIX_ENVELOPE_PARAMS.reduce(
          (acc, param) => {
            const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
            acc[param] = (track as any)?.[envelopeField] as MixtapeGainPoint[] | undefined
            return acc
          },
          {} as Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
        )
        const volumeMuteSegmentsSource = track.volumeMuteSegments
        const volumeMuteSegments = normalizeVolumeMuteSegments(volumeMuteSegmentsSource, duration)
        // 浏览器能解码的走 fetch + decodeAudioData（快、无 IPC 开销）
        const decodeMode: 'browser' | 'ipc' = canPlayHtmlAudio(filePath) ? 'browser' : 'ipc'
        return {
          trackId: track.id,
          filePath,
          startSec,
          bpm,
          beatSec,
          firstBeatSec,
          barBeatOffset,
          masterTempo,
          syncAnchorSec,
          sourceDuration,
          duration,
          tempoRatio: Math.max(0.25, Math.min(4, tempoRatio)),
          mixEnvelopes,
          mixEnvelopeSources,
          volumeMuteSegments,
          volumeMuteSegmentsSource,
          decodeMode,
          audioBuffer: null
        } as TransportEntry
      })
      .filter(Boolean) as TransportEntry[]
    entries.sort((a, b) => a.startSec - b.startSec)
    return {
      entries,
      decodeFailedCount: 0,
      missingDurationCount
    }
  }

  // ── 全部轨道预解码：通过 IPC 解码为 AudioBuffer ──────────────
  /**
   * 浏览器路径解码：fetch + decodeAudioData（快，无 IPC 开销）
   * 适用于浏览器原生支持的格式（mp3, wav, flac, ogg, opus 等）
   */
  const decodeBrowser = async (filePath: string): Promise<AudioBuffer> => {
    const url = toPreviewUrl(filePath)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch 失败: ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    if (!arrayBuffer.byteLength) throw new Error('fetch 返回空数据')
    const ctx = ensureTransportAudioContext()
    return await ctx.decodeAudioData(arrayBuffer)
  }

  /**
   * IPC 路径解码：主进程 Rust/FFmpeg 解码 → PCM Float32 → AudioBuffer
   * 适用于浏览器无法解码的格式（ape, tak, wv, dts, wma 等）
   */
  const decodeIpc = async (filePath: string): Promise<AudioBuffer> => {
    const result = await window.electron.ipcRenderer.invoke(
      'mixtape:decode-for-transport',
      filePath
    )
    const pcmData = normalizePcmData(result?.pcmData)
    const sampleRate = Number(result?.sampleRate) || 44100
    const channels = Math.max(1, Number(result?.channels) || 1)
    const totalFrames = Number(result?.totalFrames) || 0
    const frameCount =
      totalFrames > 0
        ? Math.min(totalFrames, Math.floor(pcmData.length / channels))
        : Math.floor(pcmData.length / channels)
    if (frameCount <= 0 || !pcmData.length) throw new Error('解码结果为空')
    const ctx = ensureTransportAudioContext(sampleRate)
    const buffer = ctx.createBuffer(channels, frameCount, sampleRate)
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch)
      // PCM 数据是交错格式：[L0, R0, L1, R1, ...]
      let readIndex = ch
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = pcmData[readIndex] || 0
        readIndex += channels
      }
    }
    return buffer
  }

  const ensureDecodedEntry = async (entry: TransportEntry): Promise<void> => {
    const cached = readTransportBufferCache(entry.filePath)
    if (cached) {
      entry.audioBuffer = cached
      return
    }

    const filePath = entry.filePath
    let inflight = transportDecodeInflight.get(filePath)
    if (!inflight) {
      inflight = (async () => {
        const buffer =
          entry.decodeMode === 'browser'
            ? await decodeBrowser(filePath).catch(async (error) => {
                console.warn('[mixtape-transport] 浏览器解码失败，回退 IPC 解码:', filePath, error)
                return await decodeIpc(filePath)
              })
            : await decodeIpc(filePath)
        writeTransportBufferCache(filePath, buffer)
        return buffer
      })().finally(() => {
        transportDecodeInflight.delete(filePath)
      })
      transportDecodeInflight.set(filePath, inflight)
    }
    entry.audioBuffer = await inflight
  }

  /**
   * 并行解码所有轨道，根据 decodeMode 自动选择解码路径
   */
  const decodeAllTransportEntries = async (entries: TransportEntry[]): Promise<number> => {
    if (!entries.length) return 0
    let failCount = 0
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await ensureDecodedEntry(entry)
        } catch (error) {
          console.error(
            `[mixtape-transport] 解码失败 (${entry.decodeMode}):`,
            entry.filePath,
            error
          )
          failCount += 1
        }
      })
    )
    return failCount
  }

  const preloadTransportBuffers = async () => {
    const version = ++transportPreloadVersion
    const plan = buildTransportEntries()
    const pathToEntry = new Map<string, TransportEntry>()
    for (const entry of plan.entries) {
      if (!entry.filePath || pathToEntry.has(entry.filePath)) continue
      pathToEntry.set(entry.filePath, entry)
    }
    const uniqueEntries = Array.from(pathToEntry.values())

    const keepPaths = new Set(uniqueEntries.map((entry) => entry.filePath))
    for (const key of Array.from(transportDecodedBufferCache.keys())) {
      if (!keepPaths.has(key)) {
        transportDecodedBufferCache.delete(key)
      }
    }

    transportPreloadTotal.value = uniqueEntries.length
    transportPreloadDone.value = 0
    transportPreloadFailed.value = 0

    if (!uniqueEntries.length) {
      transportPreloading.value = false
      return
    }

    transportPreloading.value = true
    const pendingEntries: TransportEntry[] = []
    for (const entry of uniqueEntries) {
      const cached = readTransportBufferCache(entry.filePath)
      if (cached) {
        transportPreloadDone.value += 1
        continue
      }
      pendingEntries.push(entry)
    }
    if (!pendingEntries.length) {
      transportPreloading.value = false
      return
    }

    let cursor = 0
    const workerCount = Math.max(1, Math.min(3, pendingEntries.length))
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (version !== transportPreloadVersion) return
        const index = cursor
        cursor += 1
        if (index >= pendingEntries.length) return
        const entry = pendingEntries[index]
        try {
          await ensureDecodedEntry(entry)
        } catch (error) {
          console.error('[mixtape-transport] 预解码失败:', entry.filePath, error)
          if (version === transportPreloadVersion) {
            transportPreloadFailed.value += 1
          }
        } finally {
          if (version === transportPreloadVersion) {
            transportPreloadDone.value += 1
          }
        }
      }
    })
    await Promise.all(workers)
    if (version !== transportPreloadVersion) return
    transportPreloading.value = false
  }

  const scheduleTransportPreload = () => {
    clearTransportPreloadTimer()
    transportPreloadTimer = setTimeout(() => {
      transportPreloadTimer = null
      void preloadTransportBuffers()
    }, 80)
  }

  // ── 启动单轨音频图播放（Source → EQ → Volume → Gain → destination）─────────
  const startTransportTrack = (entry: TransportEntry, offsetSourceSec: number, whenSec: number) => {
    if (!entry.audioBuffer) return
    try {
      const ctx = ensureTransportAudioContext(entry.audioBuffer.sampleRate)
      // 若 AudioContext 被暂停（浏览器自动挂起策略），尝试恢复
      if (ctx.state === 'suspended') {
        void ctx.resume()
      }

      // 构建音频图：Source → LowShelf → MidPeaking → HighShelf → Volume → Gain → destination
      const source = ctx.createBufferSource()
      source.buffer = entry.audioBuffer
      source.playbackRate.value = entry.tempoRatio

      const eqLow = ctx.createBiquadFilter()
      eqLow.type = 'lowshelf'
      eqLow.frequency.value = 220

      const eqMid = ctx.createBiquadFilter()
      eqMid.type = 'peaking'
      eqMid.frequency.value = 1000
      eqMid.Q.value = 0.9

      const eqHigh = ctx.createBiquadFilter()
      eqHigh.type = 'highshelf'
      eqHigh.frequency.value = 3200

      const volume = ctx.createGain()
      const gain = ctx.createGain()
      const offsetTimelineSec = offsetSourceSec / Math.max(0.01, entry.tempoRatio)
      eqHigh.gain.value = resolveEntryEqDbValue(entry, 'high', offsetTimelineSec)
      eqMid.gain.value = resolveEntryEqDbValue(entry, 'mid', offsetTimelineSec)
      eqLow.gain.value = resolveEntryEqDbValue(entry, 'low', offsetTimelineSec)
      volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
      gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)

      source.connect(eqLow)
      eqLow.connect(eqMid)
      eqMid.connect(eqHigh)
      eqHigh.connect(volume)
      volume.connect(gain)
      gain.connect(ctx.destination)

      const safeOffset = clampNumber(offsetSourceSec, 0, Math.max(0, entry.sourceDuration - 0.02))
      const safeWhen = Number.isFinite(whenSec)
        ? Math.max(ctx.currentTime, whenSec)
        : ctx.currentTime
      source.start(safeWhen, safeOffset)

      const graphNode: TrackGraphNode = {
        trackId: entry.trackId,
        entry,
        source,
        eqHigh,
        eqMid,
        eqLow,
        volume,
        gain
      }
      transportGraphNodes.push(graphNode)

      source.onended = () => {
        const idx = transportGraphNodes.indexOf(graphNode)
        if (idx >= 0) transportGraphNodes.splice(idx, 1)
        try {
          source.disconnect()
        } catch {}
        try {
          eqHigh.disconnect()
        } catch {}
        try {
          eqMid.disconnect()
        } catch {}
        try {
          eqLow.disconnect()
        } catch {}
        try {
          volume.disconnect()
        } catch {}
        try {
          gain.disconnect()
        } catch {}
      }
    } catch (error) {
      console.error('[mixtape-transport] 播放启动失败:', entry.filePath, error)
    }
  }

  const applyTransportMixParamsAtTimelineSec = (timelineSec: number) => {
    if (!transportAudioCtx || transportAudioCtx.state === 'closed') return
    const now = transportAudioCtx.currentTime
    for (const node of transportGraphNodes) {
      const entry = node.entry
      const localTimelineSec = timelineSec - entry.startSec
      if (localTimelineSec < 0 || localTimelineSec > entry.duration) continue
      const nextEqHighDb = resolveEntryEqDbValue(entry, 'high', localTimelineSec)
      const nextEqMidDb = resolveEntryEqDbValue(entry, 'mid', localTimelineSec)
      const nextEqLowDb = resolveEntryEqDbValue(entry, 'low', localTimelineSec)
      const nextVolume = resolveEntryEnvelopeValue(entry, 'volume', localTimelineSec)
      const nextGain = resolveEntryEnvelopeValue(entry, 'gain', localTimelineSec)
      try {
        node.eqHigh.gain.setTargetAtTime(nextEqHighDb, now, 0.04)
      } catch {}
      try {
        node.eqMid.gain.setTargetAtTime(nextEqMidDb, now, 0.04)
      } catch {}
      try {
        node.eqLow.gain.setTargetAtTime(nextEqLowDb, now, 0.04)
      } catch {}
      try {
        node.volume.gain.setTargetAtTime(nextVolume, now, 0.04)
      } catch {}
      try {
        node.gain.gain.setTargetAtTime(nextGain, now, 0.04)
      } catch {}
    }
  }

  // ── 核心：从指定时间点开始播放 ────────────────────────────────
  const startTransportFrom = async (rawStartSec: number) => {
    const plan = buildTransportEntries()
    stopTransport()
    const version = ++transportVersion
    const entries = plan.entries

    // 解码所有轨道（浏览器可解码的走 fetch + decodeAudioData，其余走 IPC）
    if (entries.length) {
      const pendingEntries = entries.filter((entry) => !readTransportBufferCache(entry.filePath))
      // 仅当存在需要 IPC 解码的轨道时才显示"解码中"提示
      // 浏览器 fetch + decodeAudioData 通常很快，不需要提示
      if (pendingEntries.length > 0) {
        const hasIpcEntries = pendingEntries.some((e) => e.decodeMode === 'ipc')
        if (hasIpcEntries) transportDecoding.value = true
        const failCount = await decodeAllTransportEntries(entries)
        // 检查是否被取消（用户在解码过程中点了停止或再次点击播放）
        if (transportVersion !== version) {
          transportDecoding.value = false
          return
        }
        transportDecoding.value = false
        plan.decodeFailedCount = failCount
      } else {
        for (const entry of entries) {
          const cached = readTransportBufferCache(entry.filePath)
          if (cached) {
            entry.audioBuffer = cached
          }
        }
      }
    }

    // 过滤掉解码失败的轨道
    const playableEntries = entries.filter((e) => e.audioBuffer !== null)

    const duration = playableEntries.reduce(
      (max, entry) => Math.max(max, entry.startSec + entry.duration),
      0
    )
    transportDurationSec = duration
    const startSec = clampNumber(rawStartSec, 0, Math.max(0, duration))
    transportError.value = ''
    if (!playableEntries.length || duration <= 0 || startSec >= duration) {
      playheadVisible.value = false
      playheadSec.value = startSec
      if (!playableEntries.length) {
        if (plan.decodeFailedCount > 0) {
          transportError.value = t('mixtape.transportDecodeFailed', {
            count: plan.decodeFailedCount
          })
        } else if (plan.missingDurationCount > 0) {
          transportError.value = t('mixtape.transportMissingDuration', {
            count: plan.missingDurationCount
          })
        } else {
          transportError.value = t('mixtape.transportNoPlayableTracks')
        }
      }
      return
    }
    if (plan.decodeFailedCount > 0) {
      transportError.value = t('mixtape.transportPartialDecodeFailed', {
        count: plan.decodeFailedCount
      })
    }

    playheadVisible.value = true
    playheadSec.value = startSec
    const transportCtx = ensureTransportAudioContext()
    if (transportCtx.state === 'suspended') {
      try {
        await transportCtx.resume()
      } catch {}
    }
    if (transportVersion !== version) return
    const scheduleLeadSec = 0.03
    const scheduleStartAt = transportCtx.currentTime + scheduleLeadSec
    transportBaseSec = startSec
    transportStartedAt = performance.now() + scheduleLeadSec * 1000
    transportAudioStartAt = scheduleStartAt
    transportPlaying.value = true

    for (const entry of playableEntries) {
      const entryEnd = entry.startSec + entry.duration
      if (entryEnd <= startSec) continue
      const delaySec = Math.max(0, entry.startSec - startSec)
      const offsetTimelineSec = Math.max(0, startSec - entry.startSec)
      const offsetSourceSec = offsetTimelineSec * entry.tempoRatio
      startTransportTrack(entry, offsetSourceSec, scheduleStartAt + delaySec)
    }

    const tick = () => {
      if (!transportPlaying.value) return
      const elapsed =
        transportAudioCtx && transportAudioCtx.state !== 'closed' && transportAudioStartAt > 0
          ? Math.max(0, transportAudioCtx.currentTime - transportAudioStartAt)
          : Math.max(0, (performance.now() - transportStartedAt) / 1000)
      const current = transportBaseSec + elapsed
      playheadSec.value = current
      applyTransportMixParamsAtTimelineSec(current)
      const syncResult = applyMixxxTransportSync({
        nodes: transportGraphNodes,
        timelineSec: current,
        masterTrackId: transportMasterTrackId,
        audioCtx: transportAudioCtx
      })
      transportMasterTrackId = syncResult.masterTrackId
      if (current >= transportDurationSec) {
        stopTransport()
        playheadVisible.value = false
        playheadSec.value = transportDurationSec
        return
      }
      transportRaf = requestAnimationFrame(tick)
    }
    transportRaf = requestAnimationFrame(tick)
  }

  const handleTransportToggle = () => {
    if (transportPlaying.value || transportDecoding.value) {
      finishTransportPlayback()
      return
    }
    void startTransportFrom(resolveTransportRestartSec())
  }

  const handleTransportPlayFromStart = () => {
    void startTransportFrom(0)
  }

  const handleRulerSeek = (event: MouseEvent) => {
    if (event.button !== 0) return
    void startTransportFrom(resolveRulerSeekSec(event))
  }

  const stopTransportForTrackChange = () => {
    if (!transportPlaying.value && !transportDecoding.value) return
    stopTransport()
    playheadVisible.value = false
  }

  // ── 拖拽相关（未改动）────────────────────────────────────────
  const resolvePreviousTrackId = (trackId: string) => {
    const ordered = [...tracks.value].sort(
      (a: MixtapeTrack, b: MixtapeTrack) => a.mixOrder - b.mixOrder
    )
    const index = ordered.findIndex((item: MixtapeTrack) => item.id === trackId)
    if (index <= 0) return ''
    return ordered[index - 1]?.id || ''
  }

  const findTrack = (trackId: string) =>
    tracks.value.find((item: MixtapeTrack) => item.id === trackId) || null

  const buildTrackTimingSnapshot = (inputTracks: MixtapeTrack[]) => {
    let cursorSec = 0
    return inputTracks.map((track, index) => {
      const laneIndex = index % LANE_COUNT
      const duration = resolveTrackDurationSeconds(track)
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
      const rawStartSec = Number(track.startSec)
      const startSec =
        Number.isFinite(rawStartSec) && rawStartSec >= 0 ? Math.max(0, rawStartSec) : cursorSec
      const endSec = startSec + safeDuration
      cursorSec = Math.max(cursorSec, endSec)
      return {
        id: track.id,
        laneIndex,
        startSec,
        endSec,
        durationSec: safeDuration
      }
    })
  }

  const resolveTrackDragBounds = (snapshotTracks: MixtapeTrack[], trackId: string) => {
    const timings = buildTrackTimingSnapshot(snapshotTracks)
    const target = timings.find((item) => item.id === trackId)
    if (!target) {
      return {
        minStart: 0,
        maxStart: Number.POSITIVE_INFINITY
      }
    }
    const sameLane = timings.filter((item) => item.laneIndex === target.laneIndex)
    const lanePos = sameLane.findIndex((item) => item.id === trackId)
    if (lanePos < 0) {
      return {
        minStart: 0,
        maxStart: Number.POSITIVE_INFINITY
      }
    }
    const prev = lanePos > 0 ? sameLane[lanePos - 1] : null
    const next = lanePos < sameLane.length - 1 ? sameLane[lanePos + 1] : null

    const minStart = prev ? prev.endSec : 0
    let maxStart = Number.POSITIVE_INFINITY
    if (next) {
      maxStart = Math.max(minStart, next.startSec - target.durationSec)
    }
    return {
      minStart,
      maxStart
    }
  }

  const resolveVisibleGridSnapStepBeats = () => {
    const zoomValue = Number(normalizedRenderZoom.value) || 0
    if (zoomValue >= GRID_BEAT_LINE_ZOOM) return 1
    if (zoomValue >= GRID_BEAT4_LINE_ZOOM) return 4
    return 32
  }

  const resolveSnappedStartSec = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapAnchorSec: number
    currentAnchorRawSec: number
    stepSec: number
  }) => {
    const stepSec = Number(payload.stepSec)
    if (!Number.isFinite(stepSec) || stepSec <= 0) return null
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    const snapAnchorSec = Number(payload.snapAnchorSec)
    const currentAnchorRawSec = Number(payload.currentAnchorRawSec)
    if (!Number.isFinite(snapAnchorSec) || !Number.isFinite(currentAnchorRawSec)) return null

    const startOffsetSec = rawStartSec - currentAnchorRawSec
    const rawIndex = (currentAnchorRawSec - snapAnchorSec) / stepSec
    if (!Number.isFinite(rawIndex)) return null

    let nearestIndex = Math.round(rawIndex)
    const minIndex = Math.ceil((minStartSec - startOffsetSec - snapAnchorSec) / stepSec)
    const maxIndex = Number.isFinite(maxStartSec)
      ? Math.floor((maxStartSec - startOffsetSec - snapAnchorSec) / stepSec)
      : Number.POSITIVE_INFINITY
    if (minIndex > maxIndex) return null
    nearestIndex = Math.max(minIndex, Math.min(maxIndex, nearestIndex))

    const snappedStartSec = startOffsetSec + snapAnchorSec + nearestIndex * stepSec
    if (!Number.isFinite(snappedStartSec)) return null
    return clampNumber(snappedStartSec, minStartSec, maxStartSec)
  }

  const handleTrackDragMove = (event: MouseEvent) => {
    if (!trackDragState) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const deltaSec = (event.clientX - trackDragState.startClientX) / pxPerSec
    const rawStartSec = Math.max(0, trackDragState.initialStartSec + deltaSec)
    const dragBounds = resolveTrackDragBounds(trackDragState.snapshotTracks, trackDragState.trackId)
    const clampedRawStartSec = clampNumber(rawStartSec, dragBounds.minStart, dragBounds.maxStart)
    let nextStartSec = clampedRawStartSec
    let nextBpm: number | undefined
    const currentTrackForSnap = findTrack(trackDragState.trackId)
    const snapStepBeats = resolveVisibleGridSnapStepBeats()
    const previousTrack = findTrack(trackDragState.previousTrackId)
    if (previousTrack) {
      const previousBpm = Number(previousTrack.bpm)
      if (Number.isFinite(previousBpm) && previousBpm > 0) {
        const previousStartSec = resolveTrackStartSecById(previousTrack.id)
        const previousFirstBeatSec = resolveTrackFirstBeatSeconds(previousTrack, previousBpm)
        const currentFirstBeatSecAtTarget = currentTrackForSnap
          ? resolveTrackFirstBeatSeconds(currentTrackForSnap, previousBpm)
          : 0
        const beatSec = resolveBeatSecByBpm(previousBpm)
        const snapStepSec = beatSec * snapStepBeats
        if (Number.isFinite(snapStepSec) && snapStepSec > 0) {
          const snapAnchor = resolveGridAnchorSec({
            startSec: previousStartSec,
            firstBeatSec: previousFirstBeatSec,
            beatSec,
            barBeatOffset: normalizeBeatOffset(previousTrack.barBeatOffset, 32)
          })
          const currentAnchorRawSec = resolveGridAnchorSec({
            startSec: clampedRawStartSec,
            firstBeatSec: currentFirstBeatSecAtTarget,
            beatSec,
            barBeatOffset: normalizeBeatOffset(currentTrackForSnap?.barBeatOffset, 32)
          })
          const snappedStartSec = resolveSnappedStartSec({
            rawStartSec: clampedRawStartSec,
            minStartSec: dragBounds.minStart,
            maxStartSec: dragBounds.maxStart,
            snapAnchorSec: snapAnchor,
            currentAnchorRawSec,
            stepSec: snapStepSec
          })
          if (typeof snappedStartSec === 'number') {
            nextStartSec = snappedStartSec
            nextBpm = previousBpm
          }
        }
      }
    }
    if (typeof nextBpm !== 'number' && currentTrackForSnap) {
      const currentBpm = Number(currentTrackForSnap.bpm)
      if (Number.isFinite(currentBpm) && currentBpm > 0) {
        const beatSec = resolveBeatSecByBpm(currentBpm)
        const snapStepSec = beatSec * snapStepBeats
        const currentFirstBeatSec = resolveTrackFirstBeatSeconds(currentTrackForSnap, currentBpm)
        const currentAnchorRawSec = resolveGridAnchorSec({
          startSec: clampedRawStartSec,
          firstBeatSec: currentFirstBeatSec,
          beatSec,
          barBeatOffset: normalizeBeatOffset(currentTrackForSnap.barBeatOffset, 32)
        })
        const snappedStartSec = resolveSnappedStartSec({
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          snapAnchorSec: 0,
          currentAnchorRawSec,
          stepSec: snapStepSec
        })
        if (typeof snappedStartSec === 'number') {
          nextStartSec = snappedStartSec
        }
      }
    }
    nextStartSec = clampNumber(nextStartSec, dragBounds.minStart, dragBounds.maxStart)

    const targetIndex = tracks.value.findIndex(
      (item: MixtapeTrack) => item.id === trackDragState?.trackId
    )
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const snapshotTrack =
      trackDragState.snapshotTracks.find((item: MixtapeTrack) => item.id === currentTrack.id) ||
      currentTrack
    const currentStartSec = resolveTrackStartSecById(currentTrack.id)
    const shouldUpdateStart = Math.abs(nextStartSec - currentStartSec) > 0.0001
    const shouldUpdateBpm =
      typeof nextBpm === 'number' &&
      Number.isFinite(nextBpm) &&
      nextBpm > 0 &&
      Math.abs((Number(currentTrack.bpm) || 0) - nextBpm) > 0.0001
    if (!shouldUpdateStart && !shouldUpdateBpm) return
    const nextTrack: MixtapeTrack = {
      ...currentTrack,
      startSec: nextStartSec
    }
    if (shouldUpdateBpm) {
      const safeNextBpm = Number(nextBpm)
      nextTrack.bpm = safeNextBpm
      nextTrack.masterTempo = true
      nextTrack.originalBpm =
        Number.isFinite(Number(currentTrack.originalBpm)) && Number(currentTrack.originalBpm) > 0
          ? currentTrack.originalBpm
          : Number(currentTrack.bpm) || safeNextBpm
      nextTrack.volumeMuteSegments = remapVolumeMuteSegmentsForBpm(snapshotTrack, safeNextBpm)
    }
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, nextTrack)
    tracks.value = nextTracks
    event.preventDefault()
  }

  const handleTrackDragEnd = () => {
    if (!trackDragState) return
    const targetTrackId = trackDragState.trackId
    const previousTrack =
      trackDragState.snapshotTracks.find((item: MixtapeTrack) => item.id === targetTrackId) || null
    const currentTrack = findTrack(targetTrackId)
    const previousStartSec = normalizeStartSec(previousTrack?.startSec)
    const currentStartSec = normalizeStartSec(currentTrack?.startSec)
    const normalizeTrackBpm = (value: unknown) => {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) return null
      return Number(numeric.toFixed(6))
    }
    const previousBpm = normalizeTrackBpm(previousTrack?.bpm)
    const currentBpm = normalizeTrackBpm(currentTrack?.bpm)
    const previousOriginalBpm = normalizeTrackBpm(previousTrack?.originalBpm)
    const currentOriginalBpm = normalizeTrackBpm(currentTrack?.originalBpm)
    const previousMasterTempo = previousTrack?.masterTempo !== false
    const currentMasterTempo = currentTrack?.masterTempo !== false
    isTrackDragging.value = false
    trackDragState = null
    window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
    window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!currentTrack) return
    const startChanged =
      currentStartSec !== null &&
      (previousStartSec === null || Math.abs(previousStartSec - currentStartSec) > 0.0001)
    const bpmChanged =
      currentBpm !== null && (previousBpm === null || Math.abs(previousBpm - currentBpm) > 0.0001)
    const originalBpmChanged =
      currentOriginalBpm !== null &&
      (previousOriginalBpm === null || Math.abs(previousOriginalBpm - currentOriginalBpm) > 0.0001)
    const masterTempoChanged = previousMasterTempo !== currentMasterTempo
    if (!startChanged && !bpmChanged && !originalBpmChanged && !masterTempoChanged) return
    void persistTrackStartSec([
      {
        itemId: targetTrackId,
        ...(startChanged ? { startSec: Number(currentStartSec) } : {}),
        ...(bpmChanged ? { bpm: Number(currentBpm) } : {}),
        ...(originalBpmChanged ? { originalBpm: Number(currentOriginalBpm) } : {}),
        ...(masterTempoChanged ? { masterTempo: currentMasterTempo } : {})
      }
    ])
    if (bpmChanged) {
      const currentDuration = resolveTrackDurationSeconds(currentTrack)
      const previousDuration = previousTrack ? resolveTrackDurationSeconds(previousTrack) : 0
      const currentSegments = normalizeVolumeMuteSegments(
        currentTrack.volumeMuteSegments,
        currentDuration
      )
      const previousSegments = normalizeVolumeMuteSegments(
        previousTrack?.volumeMuteSegments,
        previousDuration
      )
      if (
        JSON.stringify(currentSegments) !== JSON.stringify(previousSegments) ||
        currentSegments.length > 0 ||
        previousSegments.length > 0
      ) {
        void persistTrackVolumeMuteSegments([
          {
            itemId: targetTrackId,
            segments: currentSegments
          }
        ])
      }
    }
  }

  const handleTrackDragStart = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stopTransportForTrackChange()
    const trackId = item?.track?.id || ''
    if (!trackId) return
    const track = findTrack(trackId)
    if (!track) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    trackDragState = {
      trackId,
      startClientX: event.clientX,
      initialStartSec:
        Number.isFinite(Number(item.startSec)) && Number(item.startSec) >= 0
          ? Number(item.startSec)
          : resolveTimelineSecByX(item.startX, pxPerSec),
      previousTrackId: resolvePreviousTrackId(trackId),
      snapshotTracks: tracks.value.map((trackItem: MixtapeTrack) => ({ ...trackItem }))
    }
    isTrackDragging.value = true
    window.addEventListener('mousemove', handleTrackDragMove, { passive: false })
    window.addEventListener('mouseup', handleTrackDragEnd, { passive: true })
  }

  const cleanupTransportAndDrag = () => {
    cancelTransportPreload()
    stopTransport()
    trackDragState = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
      window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    }
    // 关闭 AudioContext 释放资源
    if (transportAudioCtx && transportAudioCtx.state !== 'closed') {
      try {
        void transportAudioCtx.close()
      } catch {}
      transportAudioCtx = null
    }
    transportDecodeInflight.clear()
    transportDecodedBufferCache.clear()
  }

  return {
    isTrackDragging,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadSec,
    playheadVisible,
    transportError,
    timelineDurationSec,
    playheadTimeLabel,
    overviewPlayheadStyle,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    stopTransportForTrackChange,
    handleTrackDragStart,
    scheduleTransportPreload,
    cleanupTransportAndDrag
  }
}
