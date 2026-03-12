import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import { normalizeBeatOffset as normalizeBeatOffsetByMixxx } from '@renderer/composables/mixtape/mixxxSyncModel'
import { applyMixxxTransportSync } from '@renderer/composables/mixtape/timelineTransportSync'
import {
  createTimelineTransportRenderWavModule,
  type MixtapeOutputProgressPayload,
  type MixtapeRenderedWavResult
} from '@renderer/composables/mixtape/timelineTransportRenderWav'
import { createTimelineTransportTrackDragModule } from '@renderer/composables/mixtape/timelineTransportTrackDrag'
import { createTimelineTransportResolversModule } from '@renderer/composables/mixtape/timelineTransportResolvers'
import { ensureTransportKeyLockWorkletModule } from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import {
  startTransportTrackGraphNode,
  type TrackGraphNode
} from '@renderer/composables/mixtape/timelineTransportPlaybackNodes'
import {
  createTimelineTransportAudioDataModule,
  type TransportAudioRef,
  type TransportEntry,
  type TransportStemId
} from '@renderer/composables/mixtape/timelineTransportAudioData'
import type {
  MixtapeEnvelopeParamId,
  MixtapeMixMode,
  MixtapeMuteSegment,
  MixtapeTrack,
  MixtapeStemStatus
} from '@renderer/composables/mixtape/types'

export type { MixtapeOutputProgressPayload, MixtapeRenderedWavResult }

const MIX_ENVELOPE_PARAMS_TRADITIONAL: MixtapeEnvelopeParamId[] = [
  'gain',
  'high',
  'mid',
  'low',
  'volume'
]
const MIX_ENVELOPE_PARAMS_4STEMS: MixtapeEnvelopeParamId[] = [
  'gain',
  'vocal',
  'inst',
  'bass',
  'drums',
  'volume'
]
const STEM_IDS_4STEMS: TransportStemId[] = ['vocal', 'inst', 'bass', 'drums']
const MIXTAPE_SEGMENT_MUTE_GAIN = 0.0001
const FOLLOW_PLAYHEAD_LOCK_RATIO = 1 / 3

export const createTimelineTransportAndDragModule = (ctx: any) => {
  const {
    tracks,
    mixtapeMixMode,
    mixtapeStemMode,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollRef,
    timelineScrollLeft,
    timelineViewportWidth,
    isTimelinePanning,
    isOverviewDragging,
    rulerRef,
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

  const transportPlaying = ref(false)
  const transportDecoding = ref(false)
  const transportPreloading = ref(false)
  const transportPreloadDone = ref(0)
  const transportPreloadTotal = ref(0)
  const transportPreloadFailed = ref(0)
  const playheadSec = ref(0)
  const playheadVisible = ref(false)
  const transportError = ref('')
  const followPlayheadEnabled = ref(false)

  let transportRaf = 0
  let transportBaseSec = 0
  let transportStartedAt = 0
  let transportAudioStartAt = 0
  let transportDurationSec = 0
  let transportAudioCtx: AudioContext | null = null
  let transportGraphNodes: TrackGraphNode[] = []
  let transportMasterTrackId = ''
  let transportVersion = 0
  let transportKeyLockWorkletReady = false

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
  const normalizeMixtapeStemStatus = (value: unknown): MixtapeStemStatus => {
    if (value === 'pending' || value === 'running' || value === 'ready' || value === 'failed') {
      return value
    }
    return 'ready'
  }
  const isStemMixMode = (): boolean =>
    (mixtapeMixMode?.value as MixtapeMixMode | undefined) === 'stem'
  const resolveMixEnvelopeParams = (): MixtapeEnvelopeParamId[] =>
    isStemMixMode() ? MIX_ENVELOPE_PARAMS_4STEMS : MIX_ENVELOPE_PARAMS_TRADITIONAL
  const resolveStemIdsForMode = (): TransportStemId[] => STEM_IDS_4STEMS
  const resolveTrackStemFilePath = (track: MixtapeTrack, stemId: TransportStemId): string => {
    if (stemId === 'vocal') return String(track.stemVocalPath || '').trim()
    if (stemId === 'inst') return String(track.stemInstPath || '').trim()
    if (stemId === 'bass') return String(track.stemBassPath || '').trim()
    return String(track.stemDrumsPath || '').trim()
  }
  const shouldUseRealtimeKeyLock = (entry: TransportEntry) =>
    entry.masterTempo && transportKeyLockWorkletReady

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

  const transportDurationSecRef = {
    get value() {
      return transportDurationSec
    },
    set value(value: number) {
      transportDurationSec = value
    }
  }
  const {
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
  } = createTimelineTransportResolversModule({
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
    segmentMuteGain: MIXTAPE_SEGMENT_MUTE_GAIN
  })

  const {
    buildTransportEntries,
    remapVolumeMuteSegmentsForBpm,
    readTransportBufferCache,
    ensureDecodedStemAudio,
    ensureDecodedTransportEntry,
    decodeAllTransportEntries,
    scheduleTransportPreload,
    cleanupTransportAudioData
  } = createTimelineTransportAudioDataModule({
    tracks,
    playheadSec,
    normalizedRenderZoom,
    timelineLayout,
    resolveRenderPxPerSec,
    buildSequentialLayoutForZoom,
    resolveTimelineSecByX,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    resolveTrackDurationSeconds,
    resolveTrackStartSec,
    resolveTrackMixEnvelope,
    resolveMixEnvelopeParams,
    resolveStemIdsForMode,
    resolveTrackStemFilePath,
    isStemMixMode,
    normalizeMixtapeStemStatus,
    ensureTransportAudioContext: (sampleRate?: number) => ensureTransportAudioContext(sampleRate),
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadFailed
  })

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
      for (const stemNode of node.stemNodes) {
        try {
          stemNode.source.stop()
        } catch {}
        try {
          stemNode.source.disconnect()
        } catch {}
        try {
          stemNode.stemGain.disconnect()
        } catch {}
      }
      try {
        node.stemBus?.disconnect()
      } catch {}
      try {
        node.eqHigh?.disconnect()
      } catch {}
      try {
        node.eqMid?.disconnect()
      } catch {}
      try {
        node.eqLow?.disconnect()
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

  const resolveTimelineViewportEl = () =>
    ((timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null) as HTMLElement | null

  const isTimelineManualScrolling = () =>
    Boolean(isTimelinePanning?.value || isOverviewDragging?.value)

  const syncTimelineScrollByPlayhead = (timelineSec: number) => {
    if (!followPlayheadEnabled.value) return
    if (isTimelineManualScrolling()) return
    const viewport = resolveTimelineViewportEl()
    if (!viewport) return
    const viewportWidth = Math.max(
      1,
      Number(viewport.clientWidth || timelineViewportWidth.value || 0)
    )
    const layoutTotalWidth = Math.max(0, Number(timelineLayout.value.totalWidth || 0))
    const scrollableWidth = Math.max(
      viewportWidth,
      layoutTotalWidth,
      Number(viewport.scrollWidth || 0)
    )
    if (scrollableWidth <= viewportWidth) return
    const maxScrollLeft = Math.max(0, scrollableWidth - viewportWidth)
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const playheadX = clampNumber(
      resolveTimelineDisplayX(timelineSec, pxPerSec, layoutTotalWidth),
      0,
      layoutTotalWidth
    )
    const targetLocalX = viewportWidth * FOLLOW_PLAYHEAD_LOCK_RATIO
    const nextLeft = clampNumber(playheadX - targetLocalX, 0, maxScrollLeft)
    const currentScrollLeft = clampNumber(Number(viewport.scrollLeft || 0), 0, maxScrollLeft)
    if (Math.abs(nextLeft - currentScrollLeft) < 0.5) return
    viewport.scrollLeft = Math.round(nextLeft)
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

  const { renderMixtapeOutputWav } = createTimelineTransportRenderWavModule({
    t,
    buildTransportEntries,
    readTransportBufferCache,
    ensureDecodedTransportEntry,
    ensureDecodedStemAudio,
    getTransportAudioContext: () => transportAudioCtx,
    clampNumber,
    resolveEntryEqDbValue,
    resolveEntryEnvelopeValue,
    isStemMode: () => isStemMixMode(),
    applyTransportMixParamsAtTimelineSec: (timelineSec: number, options?: any) =>
      applyTransportMixParamsAtTimelineSec(timelineSec, options),
    resolveStemIdsForMode,
    mirrorTransportStemPlaybackRates: (
      nodes: TrackGraphNode[],
      audioCtx: BaseAudioContext | null,
      automationAtSec?: number
    ) => mirrorTransportStemPlaybackRates(nodes, audioCtx, automationAtSec)
  })

  const resolveTransportPlanSampleRate = (entries: TransportEntry[]) => {
    for (const entry of entries) {
      if (isStemMixMode()) {
        for (const stemId of resolveStemIdsForMode()) {
          const sampleRate = Number(entry.stemAudioById?.[stemId]?.audioBuffer?.sampleRate || 0)
          if (Number.isFinite(sampleRate) && sampleRate > 0) return sampleRate
        }
        continue
      }
      const sampleRate = Number(entry.audioRef?.audioBuffer?.sampleRate || 0)
      if (Number.isFinite(sampleRate) && sampleRate > 0) return sampleRate
    }
    return undefined
  }

  const applyTransportMixParamsAtTimelineSec = (
    timelineSec: number,
    options?: {
      nodes?: TrackGraphNode[]
      audioCtx?: BaseAudioContext | null
      automationAtSec?: number
    }
  ) => {
    const audioCtx = options?.audioCtx ?? transportAudioCtx
    const nodes = options?.nodes ?? transportGraphNodes
    if (!audioCtx) return
    const now =
      typeof options?.automationAtSec === 'number' && Number.isFinite(options.automationAtSec)
        ? Number(options.automationAtSec)
        : audioCtx.currentTime
    for (const node of nodes) {
      const entry = node.entry
      const localTimelineSec = timelineSec - entry.startSec
      if (localTimelineSec < 0 || localTimelineSec > entry.duration) continue
      const nextVolume = resolveEntryEnvelopeValue(entry, 'volume', localTimelineSec)
      const nextGain = resolveEntryEnvelopeValue(entry, 'gain', localTimelineSec)
      if (isStemMixMode()) {
        for (const stemNode of node.stemNodes) {
          const nextStemGain = resolveEntryEnvelopeValue(entry, stemNode.stemId, localTimelineSec)
          try {
            stemNode.stemGain.gain.setTargetAtTime(nextStemGain, now, 0.04)
          } catch {}
        }
      } else {
        const nextEqHighDb = resolveEntryEqDbValue(entry, 'high', localTimelineSec)
        const nextEqMidDb = resolveEntryEqDbValue(entry, 'mid', localTimelineSec)
        const nextEqLowDb = resolveEntryEqDbValue(entry, 'low', localTimelineSec)
        try {
          node.eqHigh?.gain.setTargetAtTime(nextEqHighDb, now, 0.04)
        } catch {}
        try {
          node.eqMid?.gain.setTargetAtTime(nextEqMidDb, now, 0.04)
        } catch {}
        try {
          node.eqLow?.gain.setTargetAtTime(nextEqLowDb, now, 0.04)
        } catch {}
      }
      try {
        node.volume.gain.setTargetAtTime(nextVolume, now, 0.04)
      } catch {}
      try {
        node.gain.gain.setTargetAtTime(nextGain, now, 0.04)
      } catch {}
    }
  }

  function mirrorTransportStemPlaybackRates(
    nodes: TrackGraphNode[],
    audioCtx: BaseAudioContext | null,
    automationAtSec?: number
  ) {
    if (!audioCtx || !isStemMixMode()) return
    const now =
      typeof automationAtSec === 'number' && Number.isFinite(automationAtSec)
        ? Number(automationAtSec)
        : audioCtx.currentTime
    for (const node of nodes) {
      const primaryRate = clampNumber(Number(node.source.playbackRate.value) || 1, 0.25, 4)
      for (const stemNode of node.stemNodes || []) {
        if (stemNode.source === node.source) continue
        try {
          stemNode.source.playbackRate.setTargetAtTime(primaryRate, now, 0.04)
        } catch {}
      }
    }
  }

  const startTransportFrom = async (rawStartSec: number) => {
    const plan = buildTransportEntries()
    stopTransport()
    const version = ++transportVersion
    const entries = plan.entries

    if (entries.length) {
      const useStemMode = isStemMixMode()
      const pendingAudioRefs: TransportAudioRef[] = []
      if (useStemMode) {
        for (const entry of entries) {
          for (const stemId of resolveStemIdsForMode()) {
            const stemAudio = entry.stemAudioById?.[stemId]
            if (!stemAudio) continue
            if (readTransportBufferCache(stemAudio.filePath)) continue
            pendingAudioRefs.push(stemAudio)
          }
        }
      } else {
        for (const entry of entries) {
          const audioRef = entry.audioRef
          if (!audioRef) continue
          if (readTransportBufferCache(audioRef.filePath)) continue
          pendingAudioRefs.push(audioRef)
        }
      }
      if (pendingAudioRefs.length > 0) {
        const hasIpcEntries = pendingAudioRefs.some((e) => e.decodeMode === 'ipc')
        if (hasIpcEntries) transportDecoding.value = true
        const failCount = await decodeAllTransportEntries(entries)
        if (transportVersion !== version) {
          transportDecoding.value = false
          return
        }
        transportDecoding.value = false
        plan.decodeFailedCount = failCount
      } else {
        if (useStemMode) {
          for (const entry of entries) {
            for (const stemId of resolveStemIdsForMode()) {
              const stemAudio = entry.stemAudioById?.[stemId]
              if (!stemAudio) continue
              const cached = readTransportBufferCache(stemAudio.filePath)
              if (!cached) continue
              stemAudio.audioBuffer = cached
            }
          }
        } else {
          for (const entry of entries) {
            const audioRef = entry.audioRef
            if (!audioRef) continue
            const cached = readTransportBufferCache(audioRef.filePath)
            if (!cached) continue
            audioRef.audioBuffer = cached
          }
        }
      }
    }

    const playableEntries = entries.filter((entry) => {
      if (isStemMixMode()) {
        const requiredStemIds = resolveStemIdsForMode()
        return requiredStemIds.every((stemId) => !!entry.stemAudioById?.[stemId]?.audioBuffer)
      }
      return Boolean(entry.audioRef?.audioBuffer)
    })
    transportKeyLockWorkletReady = false
    if (playableEntries.some((entry) => entry.masterTempo)) {
      const sampleRate = resolveTransportPlanSampleRate(playableEntries)
      const transportCtx = ensureTransportAudioContext(sampleRate)
      if (transportCtx.state === 'suspended') {
        try {
          await transportCtx.resume()
        } catch {}
      }
      try {
        await ensureTransportKeyLockWorkletModule(transportCtx)
        transportKeyLockWorkletReady = true
      } catch (error) {
        transportKeyLockWorkletReady = false
        console.error('[mixtape-transport] key lock worklet unavailable, fallback to rate', error)
      }
      if (transportVersion !== version) return
    }

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
        } else if (isStemMixMode() && plan.missingStemAssetCount > 0) {
          transportError.value = t('mixtape.transportStemNotReady', {
            count: plan.missingStemAssetCount
          })
        } else if (isStemMixMode() && plan.stemNotReadyCount > 0) {
          transportError.value = t('mixtape.transportStemNotReady', {
            count: plan.stemNotReadyCount
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
    } else if (isStemMixMode() && plan.missingStemAssetCount > 0) {
      transportError.value = t('mixtape.transportStemNotReadySkipped', {
        count: plan.missingStemAssetCount
      })
    } else if (isStemMixMode() && plan.stemNotReadyCount > 0) {
      transportError.value = t('mixtape.transportStemNotReadySkipped', {
        count: plan.stemNotReadyCount
      })
    }

    playheadVisible.value = true
    playheadSec.value = startSec
    syncTimelineScrollByPlayhead(startSec)
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
      startTransportTrackGraphNode({
        entry,
        offsetSourceSec,
        whenSec: scheduleStartAt + delaySec,
        transportGraphNodes,
        isStemMixMode,
        resolveStemIdsForMode,
        ensureTransportAudioContext,
        shouldUseRealtimeKeyLock,
        resolveEntryEnvelopeValue: resolveEntryEnvelopeValue as any,
        resolveEntryEqDbValue
      })
    }

    const tick = () => {
      if (!transportPlaying.value) return
      const elapsed =
        transportAudioCtx && transportAudioCtx.state !== 'closed' && transportAudioStartAt > 0
          ? Math.max(0, transportAudioCtx.currentTime - transportAudioStartAt)
          : Math.max(0, (performance.now() - transportStartedAt) / 1000)
      const current = transportBaseSec + elapsed
      playheadSec.value = current
      syncTimelineScrollByPlayhead(current)
      applyTransportMixParamsAtTimelineSec(current)
      const syncResult = applyMixxxTransportSync({
        nodes: transportGraphNodes,
        timelineSec: current,
        masterTrackId: transportMasterTrackId,
        audioCtx: transportAudioCtx
      })
      transportMasterTrackId = syncResult.masterTrackId
      mirrorTransportStemPlaybackRates(transportGraphNodes, transportAudioCtx)
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

  const handleToggleFollowPlayhead = () => {
    followPlayheadEnabled.value = !followPlayheadEnabled.value
    if (!followPlayheadEnabled.value) return
    const currentSec = clampNumber(
      playheadSec.value,
      0,
      Math.max(resolveTransportDuration(), timelineDurationSec.value)
    )
    syncTimelineScrollByPlayhead(currentSec)
  }

  const stopTransportForTrackChange = () => {
    if (!transportPlaying.value && !transportDecoding.value) return
    stopTransport()
    playheadVisible.value = false
  }

  const { isTrackDragging, handleTrackDragStart, cleanupTrackDrag } =
    createTimelineTransportTrackDragModule({
      tracks,
      normalizedRenderZoom,
      resolveRenderPxPerSec,
      resolveTrackDurationSeconds,
      resolveTrackFirstBeatSeconds,
      resolveTrackStartSecById,
      resolveTimelineSecByX,
      stopTransportForTrackChange,
      scheduleFullPreRender,
      scheduleWorkerPreRender,
      persistTrackStartSec,
      persistTrackVolumeMuteSegments,
      remapVolumeMuteSegmentsForBpm,
      normalizeStartSec,
      clampNumber,
      normalizeBeatOffset
    })

  const cleanupTransportAndDrag = () => {
    cleanupTransportAudioData()
    stopTransport()
    cleanupTrackDrag()
    // 关闭 AudioContext 释放资源
    if (transportAudioCtx && transportAudioCtx.state !== 'closed') {
      try {
        void transportAudioCtx.close()
      } catch {}
      transportAudioCtx = null
    }
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
    followPlayheadEnabled,
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
    handleToggleFollowPlayhead,
    stopTransportForTrackChange,
    handleTrackDragStart,
    scheduleTransportPreload,
    cleanupTransportAndDrag,
    renderMixtapeOutputWav
  }
}
