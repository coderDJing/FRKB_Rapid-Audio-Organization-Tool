import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import confirmDialog from '@renderer/components/confirmDialog'
import { useMixtapeTimeline } from '@renderer/composables/mixtape/useMixtapeTimeline'
import { createMixtapeAutoGainController } from '@renderer/composables/mixtape/autoGainController'
import {
  MIXTAPE_ENVELOPE_PARAMS_STEM,
  MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildFlatMixEnvelope,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  normalizeBpm,
  normalizeBarBeatOffset,
  normalizeFirstBeatMs,
  normalizeMixtapeFilePath,
  normalizeUniquePaths,
  parseSnapshot
} from '@renderer/composables/mixtape/mixtapeTrackSnapshot'
import {
  applyBpmResultsToTracks,
  buildMixtapeBpmTargetKey,
  buildMixtapeBpmTargets,
  resolveMissingBpmTrackCount
} from '@renderer/composables/mixtape/mixtapeBpmAnalysis'
import {
  buildRecFilename,
  resolveMixtapeOutputProgressState
} from '@renderer/composables/mixtape/mixtapeOutputProgress'
import { createMixtapeMissingTracksNotifier } from '@renderer/composables/mixtape/mixtapeMissingTracksNotifier'
import { getKeyDisplayText as formatKeyDisplayText } from '@shared/keyDisplay'
import {
  DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE,
  DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
  resolveMixtapeStemModelByProfile
} from '@shared/mixtapeStemProfiles'
import type {
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeStemMode,
  MixtapeStemProfile as RendererMixtapeStemProfile,
  MixtapeRawItem,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type MixtapeStemSummary = {
  pending: number
  running: number
  ready: number
  failed: number
}

type StemRuntimeProgressEntry = {
  itemId: string
  filePath: string
  device: string
  percent: number
  processedSec: number | null
  totalSec: number | null
  updatedAt: number
}

const createEmptyStemSummary = (): MixtapeStemSummary => ({
  pending: 0,
  running: 0,
  ready: 0,
  failed: 0
})

const STEM_RUNTIME_PROGRESS_MAX_VISIBLE_ITEMS = 6

export const useMixtape = () => {
  const payload = ref<MixtapeOpenPayload>({})
  const mixtapeMixMode = ref<MixtapeMixMode>('stem')
  const mixtapeStemMode = ref<MixtapeStemMode>('4stems')
  const mixtapeStemRealtimeProfile = ref<RendererMixtapeStemProfile>(
    DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
  )
  const mixtapeStemExportProfile = ref<RendererMixtapeStemProfile>(
    DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
  )
  const tracks = ref<MixtapeTrack[]>([])
  const mixtapeRawItems = ref<MixtapeRawItem[]>([])
  const selectedTrackId = ref('')
  const runtime = useRuntimeStore()

  const outputPath = ref('')
  const outputFormat = ref<'wav' | 'mp3'>('wav')
  const outputFilename = ref(buildRecFilename())
  const outputStemProfile = ref<RendererMixtapeStemProfile>(DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE)
  const outputDialogVisible = ref(false)
  const outputRunning = ref(false)
  const outputProgressKey = ref('mixtape.outputProgressPreparing')
  const outputProgressPercent = ref(0)
  const outputProgressDone = ref(0)
  const outputProgressTotal = ref(100)
  const trackContextMenuVisible = ref(false)
  const trackContextMenuX = ref(0)
  const trackContextMenuY = ref(0)
  const trackContextTrackId = ref('')
  const beatAlignDialogVisible = ref(false)
  const beatAlignTrackId = ref('')

  const bpmAnalysisActive = ref(false)
  const bpmAnalysisFailed = ref(false)
  const bpmAnalysisFailedCount = ref(0)
  const bpmAnalysisFailedAutoCloseSeconds = 8
  let bpmAnalysisToken = 0
  let lastBpmAnalysisKey = ''
  let bpmAnalysisFailedTimer: ReturnType<typeof setTimeout> | null = null
  const mixtapeStemStrategyConfirmed = ref(false)
  const stemSummary = ref<MixtapeStemSummary>(createEmptyStemSummary())
  const stemRuntimeProgressByTrackId = ref<Record<string, StemRuntimeProgressEntry>>({})
  const stemResumeBootstrappedPlaylistIdSet = new Set<string>()
  const stemResumeSignatureByPlaylistId = new Map<string, string>()
  const stemCpuSlowHintShownPlaylistIdSet = new Set<string>()

  let playlistUpdateTimer: ReturnType<typeof setTimeout> | null = null
  const { notifyMissingTracksRemoved } = createMixtapeMissingTracksNotifier()

  const {
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackFirstBeatSeconds,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
    handleTrackDragStart,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    followPlayheadEnabled,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    transportError,
    renderMixtapeOutputWav,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle
  } = useMixtapeTimeline({
    tracks,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    mixtapeMixMode,
    mixtapeStemMode
  })

  const displayName = computed(() => {
    return (
      payload.value.playlistName ||
      payload.value.playlistPath ||
      payload.value.playlistId ||
      t('mixtape.playlistUnknown')
    )
  })

  const titleLabel = computed(() => {
    return `FRKB - ${t('mixtape.title')} - ${displayName.value}`
  })

  const mixtapePlaylistId = computed(() => String(payload.value.playlistId || ''))
  const normalizeMixtapeMixMode = (value: unknown): MixtapeMixMode =>
    value === 'traditional' ? 'traditional' : 'stem'
  const normalizeMixtapeStemMode = (_value: unknown): MixtapeStemMode => '4stems'
  const normalizeStemProfile = (
    value: unknown,
    fallback: RendererMixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
  ): RendererMixtapeStemProfile => normalizeMixtapeStemProfile(value, fallback)
  const isStemSpeedFirstStrategy = computed(() => {
    if (mixtapeMixMode.value !== 'stem') return false
    const realtimeProfile = normalizeStemProfile(
      mixtapeStemRealtimeProfile.value,
      DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
    )
    const exportProfile = normalizeStemProfile(
      mixtapeStemExportProfile.value,
      DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
    )
    return realtimeProfile === 'fast' && exportProfile === 'quality'
  })
  const shouldShowOutputStemProfileSelect = computed(() => isStemSpeedFirstStrategy.value)
  const normalizeMixtapeStemStatus = (value: unknown) => {
    if (value === 'pending' || value === 'running' || value === 'ready' || value === 'failed') {
      return value
    }
    return 'ready'
  }
  const normalizeStemSummaryValue = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return Math.floor(parsed)
  }
  const normalizeStemSummary = (value: unknown): MixtapeStemSummary => {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    return {
      pending: normalizeStemSummaryValue(raw.pending),
      running: normalizeStemSummaryValue(raw.running),
      ready: normalizeStemSummaryValue(raw.ready),
      failed: normalizeStemSummaryValue(raw.failed)
    }
  }
  const normalizeStemRuntimeNumber = (value: unknown): number | null => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    return parsed
  }
  const normalizeStemRuntimePercent = (value: unknown): number => {
    const parsed = normalizeStemRuntimeNumber(value)
    if (parsed === null) return 0
    return Math.max(0, Math.min(100, Math.round(parsed)))
  }
  const normalizeStemRuntimeSeconds = (value: unknown): number | null => {
    const parsed = normalizeStemRuntimeNumber(value)
    if (parsed === null || parsed < 0) return null
    return parsed
  }
  const resolveStemRuntimeFileName = (filePath: string): string => {
    const normalized = normalizeMixtapeFilePath(filePath)
    if (!normalized) return t('tracks.unknownTrack')
    const parts = normalized.split(/[\\/]/).filter(Boolean)
    return parts.at(-1) || normalized
  }
  const formatStemRuntimeTimeLabel = (seconds: number | null): string => {
    if (!Number.isFinite(seconds) || Number(seconds) < 0) return '--:--'
    const totalSeconds = Math.floor(Number(seconds))
    const minutes = Math.floor(totalSeconds / 60)
    const remainSeconds = totalSeconds % 60
    return `${minutes}:${String(remainSeconds).padStart(2, '0')}`
  }
  const removeStemRuntimeProgressByItemIds = (itemIds: string[]) => {
    if (!itemIds.length) return
    const next = { ...stemRuntimeProgressByTrackId.value }
    let changed = false
    for (const itemId of itemIds) {
      const normalizedItemId = typeof itemId === 'string' ? itemId.trim() : ''
      if (!normalizedItemId || !Object.prototype.hasOwnProperty.call(next, normalizedItemId)) {
        continue
      }
      delete next[normalizedItemId]
      changed = true
    }
    if (changed) {
      stemRuntimeProgressByTrackId.value = next
    }
  }
  const pruneStemRuntimeProgressByTracks = (trackList: MixtapeTrack[]) => {
    const validTrackIdSet = new Set(
      trackList.map((track) => (typeof track?.id === 'string' ? track.id.trim() : '')).filter(Boolean)
    )
    const next: Record<string, StemRuntimeProgressEntry> = {}
    let changed = false
    for (const [itemId, entry] of Object.entries(stemRuntimeProgressByTrackId.value)) {
      if (!validTrackIdSet.has(itemId)) {
        changed = true
        continue
      }
      next[itemId] = entry
    }
    if (changed) {
      stemRuntimeProgressByTrackId.value = next
    }
  }
  const stemSeparationProgressTotal = computed(
    () =>
      stemSummary.value.pending +
      stemSummary.value.running +
      stemSummary.value.ready +
      stemSummary.value.failed
  )
  const stemSeparationProgressDone = computed(
    () => stemSummary.value.ready + stemSummary.value.failed
  )
  const stemSeparationProgressPercent = computed(() => {
    const total = stemSeparationProgressTotal.value
    if (total <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((stemSeparationProgressDone.value / total) * 100)))
  })
  const stemSeparationProgressVisible = computed(() => {
    if (mixtapeMixMode.value !== 'stem') return false
    if (!mixtapeStemStrategyConfirmed.value) return false
    return stemSummary.value.pending + stemSummary.value.running > 0
  })
  const stemSeparationProgressText = computed(() => {
    const total = stemSeparationProgressTotal.value
    const done = stemSeparationProgressDone.value
    const running = stemSummary.value.running
    const pending = stemSummary.value.pending
    const failed = stemSummary.value.failed
    const percent = stemSeparationProgressPercent.value
    if (failed > 0) {
      return t('mixtape.stemSeparationProgressTextWithFailed', {
        percent,
        done,
        total,
        running,
        pending,
        failed
      })
    }
    return t('mixtape.stemSeparationProgressText', {
      percent,
      done,
      total,
      running,
      pending
    })
  })
  const stemSeparationRunningProgressLines = computed(() => {
    const trackIndexById = new Map<string, number>()
    const trackNameById = new Map(
      tracks.value.map((track, index) => {
        const trackId = typeof track?.id === 'string' ? track.id.trim() : ''
        if (trackId && !trackIndexById.has(trackId)) {
          trackIndexById.set(trackId, index)
        }
        return [trackId, resolveTrackTitle(track) || resolveStemRuntimeFileName(track.filePath || '')]
      })
    )
    const entries = Object.values(stemRuntimeProgressByTrackId.value)
      .filter((entry) => entry && typeof entry.itemId === 'string' && entry.itemId.trim())
      .sort((a, b) => {
        const aIndex = trackIndexById.has(a.itemId)
          ? (trackIndexById.get(a.itemId) as number)
          : Number.MAX_SAFE_INTEGER
        const bIndex = trackIndexById.has(b.itemId)
          ? (trackIndexById.get(b.itemId) as number)
          : Number.MAX_SAFE_INTEGER
        if (aIndex !== bIndex) return aIndex - bIndex
        return a.itemId.localeCompare(b.itemId)
      })
      .slice(0, STEM_RUNTIME_PROGRESS_MAX_VISIBLE_ITEMS)
    return entries.map((entry) => {
      const trackTitle =
        trackNameById.get(entry.itemId) || resolveStemRuntimeFileName(entry.filePath || '')
      return t('mixtape.stemSeparationTrackProgressText', {
        name: trackTitle,
        percent: normalizeStemRuntimePercent(entry.percent),
        processed: formatStemRuntimeTimeLabel(entry.processedSec),
        total: formatStemRuntimeTimeLabel(entry.totalSec),
        device: String(entry.device || 'cpu').toUpperCase()
      })
    })
  })
  const resolveTrackStemModel = (track: MixtapeTrack) =>
    typeof track?.stemModel === 'string' ? track.stemModel.trim() : ''
  const resolveTrackStemVersion = (track: MixtapeTrack) =>
    typeof track?.stemVersion === 'string' ? track.stemVersion.trim() : ''
  const isTrackStemTimeoutFailure = (track: MixtapeTrack) => {
    const stemError = typeof track?.stemError === 'string' ? track.stemError.toLowerCase() : ''
    if (!stemError) return false
    return stemError.includes('timeout') || stemError.includes('超时')
  }
  const hasTrackStemPathsReady = (track: MixtapeTrack, stemMode: MixtapeStemMode) => {
    const vocalPath = normalizeMixtapeFilePath((track as any)?.stemVocalPath)
    const harmonicPath = normalizeMixtapeFilePath((track as any)?.stemHarmonicPath)
    const drumsPath = normalizeMixtapeFilePath((track as any)?.stemDrumsPath)
    if (!vocalPath || !harmonicPath || !drumsPath) return false
    if (stemMode === '4stems') {
      const bassPath = normalizeMixtapeFilePath((track as any)?.stemBassPath)
      if (!bassPath) return false
    }
    return true
  }

  const trackContextMenuStyle = computed(() => ({
    left: `${trackContextMenuX.value}px`,
    top: `${trackContextMenuY.value}px`
  }))

  const beatAlignTrack = computed(() => {
    const trackId = beatAlignTrackId.value
    if (!trackId) return null
    return tracks.value.find((track) => track.id === trackId) || null
  })

  const trackContextTrack = computed(() => {
    const trackId = trackContextTrackId.value
    if (!trackId) return null
    return tracks.value.find((track) => track.id === trackId) || null
  })

  const trackMenuMasterTempoChecked = computed(() => trackContextTrack.value?.masterTempo !== false)
  const outputProgressText = computed(() => {
    const stageKey = outputProgressKey.value || 'mixtape.outputProgressPreparing'
    const stageLabel = t(stageKey as any)
    const percent = Math.max(0, Math.min(100, Number(outputProgressPercent.value) || 0))
    const done = Math.max(0, Number(outputProgressDone.value) || 0)
    const total = Math.max(0, Number(outputProgressTotal.value) || 0)
    if (total > 0 && done <= total) {
      return `${stageLabel} ${done}/${total} (${percent}%)`
    }
    return `${stageLabel} (${percent}%)`
  })

  const formatTrackKey = (value?: string) => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return ''
    if (raw.toLowerCase() === 'o') return '-'
    const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
    return formatKeyDisplayText(raw, style)
  }

  const formatTrackOriginalMeta = (track?: MixtapeTrack | null) => {
    if (!track) return ''
    const originalBpm = Number(track.originalBpm)
    const originalBpmText =
      Number.isFinite(originalBpm) && originalBpm > 0 ? formatTrackBpm(originalBpm) : ''
    const originalKeyText = formatTrackKey(track.originalKey || track.key)
    if (originalBpmText && originalKeyText) {
      return t('mixtape.originalMetaBoth', { bpm: originalBpmText, key: originalKeyText })
    }
    if (originalBpmText) {
      return t('mixtape.originalMetaBpmOnly', { bpm: originalBpmText })
    }
    if (originalKeyText) {
      return t('mixtape.originalMetaKeyOnly', { key: originalKeyText })
    }
    return ''
  }

  const resolveTrackTitleWithOriginalMeta = (track: MixtapeTrack) => {
    const baseTitle = resolveTrackTitle(track)
    const originalMeta = formatTrackOriginalMeta(track)
    if (!originalMeta) return baseTitle
    return `${baseTitle}（${originalMeta}）`
  }

  const mixtapeMenus = computed(() => [
    {
      name: 'mixtape.menuOutput',
      subMenu: [],
      directAction: 'mixtape.menuOutput',
      disabled: outputRunning.value
    }
  ])

  const applyPayload = (next: MixtapeOpenPayload) => {
    payload.value = {
      ...payload.value,
      ...(next || {})
    }
  }

  const buildBpmTargets = () => buildMixtapeBpmTargets(tracks.value)

  const resolveMissingBpmCount = (bpmTargets: Set<string>) =>
    resolveMissingBpmTrackCount(tracks.value, bpmTargets)

  const applyBpmAnalysisToTracks = (results: unknown[]) => {
    const applied = applyBpmResultsToTracks(tracks.value, results)
    if (applied.resolvedCount <= 0) return applied
    tracks.value = applied.nextTracks
    if (applied.changedCount > 0) {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
      scheduleFullPreRender()
      scheduleWorkerPreRender()
    }
    return applied
  }

  const autoResumePendingStemJobs = async (params: {
    playlistId: string
    stemMode: MixtapeStemMode
    trackList: MixtapeTrack[]
    includeRunning: boolean
    includeTimeoutFailed: boolean
  }) => {
    const playlistId = String(params.playlistId || '').trim()
    if (!playlistId || !window?.electron?.ipcRenderer?.invoke) return
    const includeRunning = !!params.includeRunning
    const includeTimeoutFailed = !!params.includeTimeoutFailed
    const resumeCandidates = params.trackList.filter((track) => {
      const status = normalizeMixtapeStemStatus(track.stemStatus)
      if (status === 'pending') return true
      if (includeRunning && status === 'running') return true
      if (includeTimeoutFailed && status === 'failed' && isTrackStemTimeoutFailure(track)) {
        return true
      }
      return false
    })
    if (!resumeCandidates.length) {
      stemResumeSignatureByPlaylistId.delete(playlistId)
      return
    }

    const grouped = new Map<
      string,
      {
        model: string
        profile: RendererMixtapeStemProfile
        stemVersion?: string
        filePathSet: Set<string>
      }
    >()
    for (const track of resumeCandidates) {
      const filePath = normalizeMixtapeFilePath(track.filePath)
      if (!filePath) continue
      const model = resolveTrackStemModel(track)
      const stemVersion = resolveTrackStemVersion(track)
      const parsedModel = parseMixtapeStemModel(model, mixtapeStemRealtimeProfile.value)
      const requestedModel = parsedModel.requestedModel
      const profile = normalizeStemProfile(parsedModel.profile, mixtapeStemRealtimeProfile.value)
      const groupKey = `${requestedModel}::${profile}::${stemVersion || ''}`
      const existing = grouped.get(groupKey)
      if (existing) {
        existing.filePathSet.add(filePath)
        continue
      }
      grouped.set(groupKey, {
        model: requestedModel,
        profile,
        stemVersion: stemVersion || undefined,
        filePathSet: new Set<string>([filePath])
      })
    }
    if (!grouped.size) {
      stemResumeSignatureByPlaylistId.delete(playlistId)
      return
    }

    const signature = Array.from(grouped.entries())
      .map(([groupKey, group]) => {
        const filePathSignature = Array.from(group.filePathSet).sort().join('|')
        return `${groupKey}::${filePathSignature}`
      })
      .sort()
      .join('\n')
    if (!signature) {
      stemResumeSignatureByPlaylistId.delete(playlistId)
      return
    }
    const lastSignature = stemResumeSignatureByPlaylistId.get(playlistId) || ''
    if (lastSignature === signature) return

    for (const group of grouped.values()) {
      const filePaths = Array.from(group.filePathSet)
      if (!filePaths.length) continue
      try {
        await window.electron.ipcRenderer.invoke('mixtape:stem:enqueue', {
          playlistId,
          filePaths,
          stemMode: params.stemMode,
          profile: group.profile,
          model: group.model,
          stemVersion: group.stemVersion,
          force: false
        })
      } catch (error) {
        console.error('[mixtape] auto resume pending stem jobs failed', {
          playlistId,
          profile: group.profile,
          model: group.model || null,
          count: filePaths.length,
          error
        })
      }
    }
    stemResumeSignatureByPlaylistId.set(playlistId, signature)
  }

  const handleBpmBatchReady = (_e: unknown, payload: any) => {
    const results = Array.isArray(payload?.results) ? payload.results : []
    if (!results.length) return
    const { resolvedCount } = applyBpmAnalysisToTracks(results)
    if (resolvedCount <= 0) return
    const filePaths = buildBpmTargets()
    const bpmTargets = new Set(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
    if (missingTrackCount === 0) {
      if (bpmAnalysisActive.value) {
        bpmAnalysisToken += 1
      }
      lastBpmAnalysisKey = buildMixtapeBpmTargetKey(filePaths)
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
    } else if (bpmAnalysisFailed.value) {
      bpmAnalysisFailedCount.value = missingTrackCount
      scheduleBpmAnalysisFailureAutoClose()
    }
    scheduleTimelineDraw()
  }

  const clearBpmAnalysisFailedTimer = () => {
    if (!bpmAnalysisFailedTimer) return
    clearTimeout(bpmAnalysisFailedTimer)
    bpmAnalysisFailedTimer = null
  }

  const dismissBpmAnalysisFailure = () => {
    clearBpmAnalysisFailedTimer()
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0
  }

  const scheduleBpmAnalysisFailureAutoClose = () => {
    clearBpmAnalysisFailedTimer()
    bpmAnalysisFailedTimer = setTimeout(() => {
      if (!bpmAnalysisActive.value) {
        dismissBpmAnalysisFailure()
      }
    }, bpmAnalysisFailedAutoCloseSeconds * 1000)
  }

  const retryBpmAnalysis = () => {
    if (bpmAnalysisActive.value) return
    dismissBpmAnalysisFailure()
    void requestMixtapeBpmAnalysis()
  }

  const requestMixtapeBpmAnalysis = async () => {
    const filePaths = buildBpmTargets()
    if (!filePaths.length || !window?.electron?.ipcRenderer?.invoke) {
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      return
    }
    const bpmTargets = new Set(filePaths)
    const missingPathCount = tracks.value.filter(
      (track) => !normalizeMixtapeFilePath(track.filePath)
    ).length
    if (missingPathCount > 0) {
      console.warn('[mixtape] BPM analyze skipped tracks without file path', { missingPathCount })
    }
    const key = buildMixtapeBpmTargetKey(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
    const hasMissingBpm = missingTrackCount > 0
    if (!hasMissingBpm) {
      lastBpmAnalysisKey = key
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      scheduleTimelineDraw()
      return
    }

    const token = (bpmAnalysisToken += 1)
    let allResolved = false
    clearBpmAnalysisFailedTimer()
    bpmAnalysisActive.value = true
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0

    scheduleTimelineDraw()
    try {
      const result = await window.electron.ipcRenderer.invoke('mixtape:analyze-bpm', { filePaths })
      if (token !== bpmAnalysisToken) return
      const results = Array.isArray(result?.results) ? result.results : []
      const unresolved = Array.isArray(result?.unresolved) ? result.unresolved : []
      const unresolvedDetails = Array.isArray(result?.unresolvedDetails)
        ? result.unresolvedDetails
        : []
      if (unresolvedDetails.length > 0) {
        console.warn('[mixtape] BPM analyze unresolved details', {
          count: unresolvedDetails.length,
          sample: unresolvedDetails.slice(0, 5)
        })
      }
      if (results.length > 0) {
        const { resolvedCount } = applyBpmAnalysisToTracks(results)
        const remainMissingCount = resolveMissingBpmCount(bpmTargets)
        if (remainMissingCount > 0) {
          bpmAnalysisFailed.value = true
          bpmAnalysisFailedCount.value = Math.max(
            remainMissingCount,
            unresolvedDetails.length,
            unresolved.length,
            Math.max(0, filePaths.length - resolvedCount)
          )
          scheduleBpmAnalysisFailureAutoClose()
        } else {
          allResolved = true
        }
      } else if (filePaths.length > 0) {
        bpmAnalysisFailed.value = true
        bpmAnalysisFailedCount.value = Math.max(unresolved.length, filePaths.length)
        scheduleBpmAnalysisFailureAutoClose()
      }
    } catch (error) {
      bpmAnalysisFailed.value = true
      bpmAnalysisFailedCount.value = Math.max(filePaths.length, 1)
      scheduleBpmAnalysisFailureAutoClose()
      console.error('[mixtape] BPM analyze invoke failed', {
        fileCount: filePaths.length,
        error
      })
    } finally {
      if (token === bpmAnalysisToken) {
        if (allResolved) {
          lastBpmAnalysisKey = key
          dismissBpmAnalysisFailure()
        } else if (lastBpmAnalysisKey === key) {
          lastBpmAnalysisKey = ''
        }
        bpmAnalysisActive.value = false
        scheduleTimelineDraw()
      }
    }
  }

  const loadMixtapeItems = async () => {
    if (!payload.value.playlistId) {
      mixtapeRawItems.value = []
      mixtapeMixMode.value = 'stem'
      mixtapeStemMode.value = '4stems'
      mixtapeStemRealtimeProfile.value = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
      mixtapeStemExportProfile.value = DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
      outputStemProfile.value = DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
      mixtapeStemStrategyConfirmed.value = false
      stemSummary.value = createEmptyStemSummary()
      stemRuntimeProgressByTrackId.value = {}
      tracks.value = []
      selectedTrackId.value = ''
      resetAutoGainState()
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      lastBpmAnalysisKey = ''
      return
    }
    const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
      playlistId: payload.value.playlistId
    })
    mixtapeMixMode.value = normalizeMixtapeMixMode(result?.mixMode)
    mixtapeStemMode.value = normalizeMixtapeStemMode(result?.stemMode)
    mixtapeStemRealtimeProfile.value = normalizeStemProfile(
      result?.stemRealtimeProfile,
      DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
    )
    mixtapeStemExportProfile.value = normalizeStemProfile(
      result?.stemExportProfile,
      DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
    )
    outputStemProfile.value = normalizeStemProfile(
      result?.stemExportProfile,
      DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
    )
    mixtapeStemStrategyConfirmed.value = !!result?.stemStrategyConfirmed
    stemSummary.value = normalizeStemSummary(result?.stemSummary)
    const rawItems = Array.isArray(result?.items) ? result.items : []
    mixtapeRawItems.value = rawItems
    const removedPaths = Array.isArray(result?.recovery?.removedPaths)
      ? normalizeUniquePaths(result.recovery.removedPaths)
      : []
    tracks.value = rawItems.map((item: MixtapeRawItem, index: number) =>
      parseSnapshot(item, index, t('tracks.unknownTrack'))
    )
    pruneStemRuntimeProgressByTracks(tracks.value)
    const stemMode = normalizeMixtapeStemMode(result?.stemMode)
    const currentPlaylistId = String(payload.value.playlistId || '').trim()

    if (mixtapeMixMode.value === 'stem' && mixtapeStemStrategyConfirmed.value) {
      const missingStemAssetReadyTracks = tracks.value.filter(
        (track) =>
          normalizeMixtapeStemStatus(track.stemStatus) === 'ready' &&
          !hasTrackStemPathsReady(track, stemMode)
      )
      if (missingStemAssetReadyTracks.length > 0 && window?.electron?.ipcRenderer?.invoke) {
        const repairFilePaths = Array.from(
          new Set(
            missingStemAssetReadyTracks
              .map((track) => normalizeMixtapeFilePath(track.filePath))
              .filter(Boolean)
          )
        )
        if (repairFilePaths.length > 0) {
          void window.electron.ipcRenderer
            .invoke('mixtape:stem:enqueue', {
              playlistId: payload.value.playlistId,
              filePaths: repairFilePaths,
              stemMode,
              profile: mixtapeStemRealtimeProfile.value,
              force: false
            })
            .catch((error) => {
              console.error('[mixtape] stem path backfill enqueue failed', {
                playlistId: payload.value.playlistId,
                count: repairFilePaths.length,
                error
              })
            })
        }
      }
      if (currentPlaylistId) {
        const includeRunning = !stemResumeBootstrappedPlaylistIdSet.has(currentPlaylistId)
        const includeTimeoutFailed = !stemResumeBootstrappedPlaylistIdSet.has(currentPlaylistId)
        await autoResumePendingStemJobs({
          playlistId: currentPlaylistId,
          stemMode,
          trackList: tracks.value,
          includeRunning,
          includeTimeoutFailed
        })
        stemResumeBootstrappedPlaylistIdSet.add(currentPlaylistId)
      }
    } else if (currentPlaylistId) {
      stemResumeBootstrappedPlaylistIdSet.delete(currentPlaylistId)
      stemResumeSignatureByPlaylistId.delete(currentPlaylistId)
      console.info('[mixtape] stem auto enqueue skipped: non-stem mode or strategy not confirmed', {
        playlistId: currentPlaylistId
      })
    }
    if (!tracks.value.some((track) => track.id === selectedTrackId.value)) {
      selectedTrackId.value = tracks.value[0]?.id || ''
    }
    syncAutoGainReferenceTrack()
    if (!tracks.value.some((track) => track.id === beatAlignTrackId.value)) {
      beatAlignDialogVisible.value = false
      beatAlignTrackId.value = ''
    }
    closeTrackContextMenu()
    if (removedPaths.length > 0) {
      void notifyMissingTracksRemoved(payload.value.playlistId || '', removedPaths)
    }
    void requestMixtapeBpmAnalysis()
  }

  const closeTrackContextMenu = () => {
    trackContextMenuVisible.value = false
    trackContextTrackId.value = ''
  }

  const openBeatAlignDialog = (trackId: string) => {
    const found = tracks.value.find((track) => track.id === trackId)
    if (!found) return
    beatAlignTrackId.value = trackId
    beatAlignDialogVisible.value = true
  }

  const handleTrackContextMenu = (item: TimelineTrackLayout, event: MouseEvent) => {
    const trackId = item?.track?.id || ''
    if (!trackId) return
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 150
    const menuHeight = 70
    const safeX = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, event.clientX))
    const safeY = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, event.clientY))
    trackContextMenuX.value = safeX
    trackContextMenuY.value = safeY
    trackContextTrackId.value = trackId
    trackContextMenuVisible.value = true
  }

  const handleTrackMenuAdjustGrid = () => {
    const trackId = trackContextTrackId.value
    closeTrackContextMenu()
    if (!trackId) return
    openBeatAlignDialog(trackId)
  }

  const handleTrackMenuToggleMasterTempo = () => {
    const trackId = trackContextTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const nextMasterTempo = currentTrack.masterTempo === false
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, {
      ...currentTrack,
      masterTempo: nextMasterTempo
    })
    tracks.value = nextTracks
    if (window?.electron?.ipcRenderer?.invoke) {
      void window.electron.ipcRenderer
        .invoke('mixtape:update-track-start-sec', {
          entries: [
            {
              itemId: currentTrack.id,
              masterTempo: nextMasterTempo
            }
          ]
        })
        .catch((error) => {
          console.error('[mixtape] update master tempo failed', {
            itemId: currentTrack.id,
            masterTempo: nextMasterTempo,
            error
          })
        })
    }
    closeTrackContextMenu()
    scheduleTimelineDraw()
  }

  const handleBeatAlignDialogCancel = () => {
    beatAlignDialogVisible.value = false
    beatAlignTrackId.value = ''
  }

  const handleBeatAlignGridDefinitionSave = async (payload: {
    barBeatOffset: number
    firstBeatMs: number
    bpm: number
  }) => {
    const trackId = beatAlignTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const normalizedOffset = normalizeBarBeatOffset(payload?.barBeatOffset)
    const normalizedFirstBeatMs = normalizeFirstBeatMs(payload?.firstBeatMs)
    const normalizedInputBpm = normalizeBpm(payload?.bpm)
    const currentOffset = normalizeBarBeatOffset(currentTrack.barBeatOffset)
    const currentFirstBeatMs = normalizeFirstBeatMs(currentTrack.firstBeatMs)
    const offsetChanged = normalizedOffset !== currentOffset
    const firstBeatChanged = Math.abs(normalizedFirstBeatMs - currentFirstBeatMs) > 0.0001
    const targetFilePath = normalizeMixtapeFilePath(currentTrack.filePath)
    const gridBaseBpm = normalizeBpm(currentTrack.gridBaseBpm)
    const originalBpm = normalizeBpm(currentTrack.originalBpm)
    const bpmCompareBase = gridBaseBpm ?? originalBpm ?? normalizeBpm(currentTrack.bpm)
    const shouldPersistBpm =
      normalizedInputBpm !== null &&
      (bpmCompareBase === null || Math.abs(normalizedInputBpm - bpmCompareBase) > 0.0001)
    const isSameTrack = (track: MixtapeTrack) =>
      targetFilePath.length > 0
        ? normalizeMixtapeFilePath(track.filePath) === targetFilePath
        : track.id === trackId
    const bpmChanged =
      shouldPersistBpm &&
      tracks.value.some((track) => {
        if (!isSameTrack(track)) return false
        const trackBpmBase =
          normalizeBpm(track.gridBaseBpm) ??
          normalizeBpm(track.originalBpm) ??
          normalizeBpm(track.bpm)
        if (trackBpmBase === null) return true
        return Math.abs(trackBpmBase - Number(normalizedInputBpm)) > 0.0001
      })
    if (!offsetChanged && !firstBeatChanged && !bpmChanged) return
    const gridPositionChanged = firstBeatChanged || bpmChanged
    const activeEnvelopeParams =
      mixtapeMixMode.value === 'traditional'
        ? MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL
        : MIXTAPE_ENVELOPE_PARAMS_STEM
    const shouldResetEnvelope = gridPositionChanged
      ? (await confirmDialog({
          title: t('mixtape.gridAdjustSaveResetEnvelopeTitle'),
          content: [t('mixtape.gridAdjustSaveResetEnvelopeHint')],
          confirmText: t('mixtape.gridAdjustSaveResetEnvelopeConfirm'),
          cancelText: t('mixtape.gridAdjustSaveResetEnvelopeCancel')
        })) === 'confirm'
      : false
    if (gridPositionChanged && !shouldResetEnvelope) return
    const nextTracks = tracks.value.map((track) => {
      if (!isSameTrack(track)) return track
      const fallbackGridBaseBpm =
        normalizeBpm(track.gridBaseBpm) ?? normalizeBpm(track.originalBpm) ?? track.gridBaseBpm
      const nextTrack = {
        ...track,
        barBeatOffset: normalizedOffset,
        firstBeatMs: normalizedFirstBeatMs,
        gridBaseBpm:
          shouldPersistBpm && normalizedInputBpm !== null
            ? Number(normalizedInputBpm)
            : fallbackGridBaseBpm,
        bpm:
          shouldPersistBpm && normalizedInputBpm !== null ? Number(normalizedInputBpm) : track.bpm
      }
      if (!shouldResetEnvelope) return nextTrack
      for (const param of activeEnvelopeParams) {
        const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
        ;(nextTrack as any)[envelopeField] = buildFlatMixEnvelope(
          param,
          resolveTrackDurationSeconds(track),
          1
        )
      }
      nextTrack.volumeMuteSegments = []
      return nextTrack
    })
    tracks.value = nextTracks
    scheduleTimelineDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!window?.electron?.ipcRenderer?.invoke) return

    if (targetFilePath) {
      void window.electron.ipcRenderer
        .invoke('mixtape:update-grid-definition', {
          filePath: targetFilePath,
          barBeatOffset: normalizedOffset,
          firstBeatMs: normalizedFirstBeatMs,
          bpm: bpmChanged ? normalizedInputBpm : undefined
        })
        .catch((error) => {
          console.error('[mixtape] update grid definition failed', {
            filePath: targetFilePath,
            barBeatOffset: normalizedOffset,
            firstBeatMs: normalizedFirstBeatMs,
            bpm: bpmChanged ? normalizedInputBpm : undefined,
            error
          })
        })
    }

    if (!shouldResetEnvelope) return
    const affectedTracks = nextTracks.filter((track) => isSameTrack(track))
    if (!affectedTracks.length) return
    const envelopeUpdateTasks = activeEnvelopeParams.map((param) => {
      const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
      const entries = affectedTracks
        .map((track) => {
          const points = normalizeMixEnvelopePoints(
            param,
            (track as any)?.[envelopeField],
            resolveTrackDurationSeconds(track)
          )
          if (points.length < 2) return null
          return {
            itemId: track.id,
            gainEnvelope: points.map((point) => ({
              sec: Number(point.sec),
              gain: Number(point.gain)
            }))
          }
        })
        .filter(
          (item): item is { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } =>
            item !== null
        )
      if (!entries.length) return Promise.resolve(null)
      return window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
        param,
        entries
      })
    })
    const muteSegmentUpdateEntries = affectedTracks.map((track) => ({
      itemId: track.id,
      segments: []
    }))
    const muteSegmentUpdateTask =
      muteSegmentUpdateEntries.length > 0
        ? window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
            entries: muteSegmentUpdateEntries
          })
        : Promise.resolve(null)
    void Promise.all([...envelopeUpdateTasks, muteSegmentUpdateTask]).catch((error) => {
      console.error('[mixtape] reset mix envelope after grid update failed', {
        trackCount: affectedTracks.length,
        error
      })
    })
  }

  const handleGlobalPointerDown = (event: PointerEvent) => {
    if (!trackContextMenuVisible.value) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.mixtape-track-menu')) return
    closeTrackContextMenu()
  }

  const isEditableEventTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null
    if (!element) return false
    if (element.isContentEditable) return true
    const tag = element.tagName?.toLowerCase() || ''
    return tag === 'input' || tag === 'textarea' || tag === 'select'
  }

  const handleWindowKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.isComposing) return
    if (event.code !== 'Space' && event.key !== ' ') return
    if (event.repeat) {
      event.preventDefault()
      return
    }
    if (isEditableEventTarget(event.target)) return
    if (
      beatAlignDialogVisible.value ||
      outputDialogVisible.value ||
      outputRunning.value ||
      autoGainDialogVisible.value
    )
      return

    event.preventDefault()
    if (transportPlaying.value || transportDecoding.value) {
      handleTransportStop()
      return
    }
    handleTransportPlayFromStart()
  }

  const openOutputDialog = () => {
    if (outputRunning.value) return
    outputStemProfile.value = shouldShowOutputStemProfileSelect.value
      ? 'quality'
      : normalizeStemProfile(mixtapeStemExportProfile.value, DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE)
    outputDialogVisible.value = true
  }

  const applyOutputProgressPayload = (payload: any) => {
    const nextState = resolveMixtapeOutputProgressState(
      {
        stageKey: outputProgressKey.value,
        done: outputProgressDone.value,
        total: outputProgressTotal.value,
        percent: outputProgressPercent.value
      },
      payload
    )
    outputProgressKey.value = nextState.stageKey
    outputProgressDone.value = nextState.done
    outputProgressTotal.value = nextState.total
    outputProgressPercent.value = nextState.percent
  }

  const runMixtapeOutput = async () => {
    if (outputRunning.value) return
    const normalizedOutputPath = outputPath.value.trim()
    const normalizedFilename = outputFilename.value.trim()
    if (!normalizedOutputPath) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputPathRequired')],
        confirmShow: false
      })
      return
    }
    if (!normalizedFilename) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputFilenameRequired')],
        confirmShow: false
      })
      return
    }
    if (!tracks.value.length) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputNoTracks')],
        confirmShow: false
      })
      return
    }
    if (mixtapeMixMode.value === 'stem') {
      const exportProfile = normalizeStemProfile(
        shouldShowOutputStemProfileSelect.value ? outputStemProfile.value : mixtapeStemExportProfile.value,
        DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
      )
      const exportModel = resolveMixtapeStemModelByProfile(exportProfile)
      const notReadyTracks = tracks.value.filter((track) => {
        if (normalizeMixtapeStemStatus(track.stemStatus) !== 'ready') return true
        if (!hasTrackStemPathsReady(track, mixtapeStemMode.value)) return true
        return resolveTrackStemModel(track) !== exportModel
      })
      if (notReadyTracks.length > 0) {
        const trackSample = notReadyTracks.slice(0, 3).map((track) => resolveTrackTitle(track))
        const filePaths = Array.from(
          new Set(
            notReadyTracks
              .map((track) => normalizeMixtapeFilePath(track.filePath))
              .filter((filePath): filePath is string => !!filePath)
          )
        )
        if (
          filePaths.length > 0 &&
          window?.electron?.ipcRenderer?.invoke &&
          payload.value.playlistId
        ) {
          try {
            await window.electron.ipcRenderer.invoke('mixtape:stem:enqueue', {
              playlistId: payload.value.playlistId,
              filePaths,
              stemMode: mixtapeStemMode.value,
              profile: exportProfile,
              force: false
            })
          } catch (error) {
            console.error('[mixtape] enqueue export stem profile failed', {
              playlistId: payload.value.playlistId,
              profile: exportProfile,
              count: filePaths.length,
              error
            })
          }
        }
        await confirmDialog({
          title: t('common.warning'),
          content: [
            t('mixtape.exportStemPreparing', { count: notReadyTracks.length }),
            ...trackSample
          ],
          confirmShow: false
        })
        return
      }
    }

    outputRunning.value = true
    outputProgressKey.value = 'mixtape.outputProgressPreparing'
    outputProgressDone.value = 0
    outputProgressTotal.value = 100
    outputProgressPercent.value = 0
    await nextTick()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    const outputRequest = {
      outputPath: normalizedOutputPath,
      outputFormat: outputFormat.value,
      outputFilename: normalizedFilename
    }

    try {
      const rendered = await renderMixtapeOutputWav({
        onProgress: applyOutputProgressPayload
      })
      const result = await window.electron.ipcRenderer.invoke('mixtape:output', {
        ...outputRequest,
        wavBytes: rendered.wavBytes,
        durationSec: rendered.durationSec,
        sampleRate: rendered.sampleRate,
        channels: rendered.channels
      })
      if (!result?.ok) {
        throw new Error(result?.error || t('common.unknownError'))
      }
      applyOutputProgressPayload({
        stageKey: 'mixtape.outputProgressFinished',
        done: 100,
        total: 100,
        percent: 100
      })
      outputRunning.value = false
      await confirmDialog({
        title: t('common.finished'),
        content: [t('mixtape.outputFinishedHint', { path: String(result?.outputPath || '') })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 500
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || t('common.error'))
      applyOutputProgressPayload({
        stageKey: 'mixtape.outputProgressFailed',
        done: 100,
        total: 100,
        percent: 100
      })
      outputRunning.value = false
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputFailedHint', { reason: message })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 500
      })
    } finally {
      outputRunning.value = false
    }
  }

  const handleOutputDialogConfirm = async (payload: {
    outputPath: string
    outputFormat: 'wav' | 'mp3'
    outputFilename: string
    stemProfile?: RendererMixtapeStemProfile
  }) => {
    outputPath.value = payload.outputPath
    outputFormat.value = payload.outputFormat
    outputFilename.value = payload.outputFilename
    outputStemProfile.value = normalizeStemProfile(payload.stemProfile, outputStemProfile.value)
    outputDialogVisible.value = false
    await runMixtapeOutput()
  }

  const handleOutputDialogCancel = () => {
    outputDialogVisible.value = false
  }

  const persistGainEnvelope = async (
    entries: Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-gain-envelope', { entries })
    } catch (error) {
      console.error('[mixtape] update gain envelope failed', {
        count: entries.length,
        error
      })
    }
  }

  const showAutoGainErrorDialog = async (message: string) => {
    await confirmDialog({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  }

  const {
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainBusy,
    autoGainReferenceOptions,
    autoGainProgressText,
    canStartAutoGain,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference,
    syncReferenceTrack: syncAutoGainReferenceTrack,
    resetAutoGainState
  } = createMixtapeAutoGainController({
    tracks,
    selectedTrackId,
    transportPlaying,
    transportDecoding,
    bpmAnalysisActive,
    resolveTrackTitle,
    t,
    onStopTransport: handleTransportStop,
    onEnvelopeApplied: () => {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
    },
    persistGainEnvelope,
    showErrorDialog: showAutoGainErrorDialog
  })

  const schedulePlaylistReload = () => {
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
    }
    playlistUpdateTimer = setTimeout(() => {
      playlistUpdateTimer = null
      loadMixtapeItems()
    }, 120)
  }

  const handlePlaylistContentChanged = (eventPayload: any) => {
    const playlistId = payload.value.playlistId
    if (!playlistId) return
    const uuids: string[] = Array.isArray(eventPayload?.uuids)
      ? eventPayload.uuids.filter(Boolean)
      : []
    if (!uuids.includes(playlistId)) return
    schedulePlaylistReload()
  }

  const handleMixtapeStemStatusUpdated = (_e: unknown, eventPayload: any) => {
    const playlistId = payload.value.playlistId
    if (!playlistId) return
    const targetPlaylistId =
      typeof eventPayload?.playlistId === 'string' ? eventPayload.playlistId.trim() : ''
    if (!targetPlaylistId || targetPlaylistId !== playlistId) return
    const stemStatus = normalizeMixtapeStemStatus(eventPayload?.stemStatus)
    const itemIds = Array.isArray(eventPayload?.itemIds)
      ? eventPayload.itemIds
          .map((itemId: unknown) => (typeof itemId === 'string' ? itemId.trim() : ''))
          .filter(Boolean)
      : []
    if (stemStatus !== 'running' && itemIds.length > 0) {
      removeStemRuntimeProgressByItemIds(itemIds)
    }
    if (eventPayload && typeof eventPayload === 'object') {
      stemSummary.value = normalizeStemSummary(eventPayload.stemSummary)
    }
    schedulePlaylistReload()
  }

  const handleMixtapeStemCpuSlowHint = (_e: unknown, eventPayload: any) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId) return
    const targetPlaylistId =
      typeof eventPayload?.playlistId === 'string' ? eventPayload.playlistId.trim() : ''
    if (!targetPlaylistId || targetPlaylistId !== playlistId) return
    if (stemCpuSlowHintShownPlaylistIdSet.has(playlistId)) return
    stemCpuSlowHintShownPlaylistIdSet.add(playlistId)
    const reasonCode =
      typeof eventPayload?.reasonCode === 'string' ? eventPayload.reasonCode.trim() : ''
    const reasonText =
      reasonCode === 'gpu_unavailable'
        ? t('mixtape.stemCpuSlowHintReasonGpuUnavailable')
        : reasonCode === 'gpu_failed'
          ? t('mixtape.stemCpuSlowHintReasonGpuFailed')
          : reasonCode === 'gpu_backend_missing'
            ? t('mixtape.stemCpuSlowHintReasonGpuBackendMissing')
          : t('mixtape.stemCpuSlowHintReasonUnknown')
    const content = [
      t('mixtape.stemCpuSlowHintReasonLine', { reason: reasonText }),
      t('mixtape.stemCpuSlowHint')
    ]
    void confirmDialog({
      title: t('common.warning'),
      content,
      confirmShow: false
    })
  }

  const handleMixtapeStemRuntimeProgress = (_e: unknown, eventPayload: any) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId) return
    const targetPlaylistId =
      typeof eventPayload?.playlistId === 'string' ? eventPayload.playlistId.trim() : ''
    if (!targetPlaylistId || targetPlaylistId !== playlistId) return
    const itemIds = Array.isArray(eventPayload?.itemIds)
      ? eventPayload.itemIds
          .map((itemId: unknown) => (typeof itemId === 'string' ? itemId.trim() : ''))
          .filter(Boolean)
      : []
    if (!itemIds.length) return
    const percent = normalizeStemRuntimePercent(eventPayload?.percent)
    const processedSec = normalizeStemRuntimeSeconds(eventPayload?.processedSec)
    const totalSec = normalizeStemRuntimeSeconds(eventPayload?.totalSec)
    const filePath = normalizeMixtapeFilePath(eventPayload?.filePath)
    const device =
      typeof eventPayload?.device === 'string' && eventPayload.device.trim()
        ? eventPayload.device.trim().toLowerCase()
        : 'cpu'
    const updatedAt = Date.now()
    const next = { ...stemRuntimeProgressByTrackId.value }
    for (const itemId of itemIds) {
      next[itemId] = {
        itemId,
        filePath,
        device,
        percent,
        processedSec,
        totalSec,
        updatedAt
      }
    }
    stemRuntimeProgressByTrackId.value = next
  }

  const handleOpen = (_e: any, next: MixtapeOpenPayload) => {
    if (!next || typeof next !== 'object') return
    applyPayload(next)
    loadMixtapeItems()
  }

  const handleMixtapeOutputProgress = (_e: unknown, payload: any) => {
    applyOutputProgressPayload(payload)
  }

  const handleTitleOpenDialog = (key: string) => {
    if (!key) return
    if (key === 'mixtape.menuOutput') {
      if (outputRunning.value) return
      openOutputDialog()
      return
    }
    if (key === 'menu.exit') {
      window.electron.ipcRenderer.send('toggle-close')
      window.electron.ipcRenderer.send('mixtapeWindow-toggle-close')
      return
    }
    window.electron.ipcRenderer.send('mixtapeWindow-open-dialog', key)
  }

  watch(
    () => payload.value.playlistId,
    (nextPlaylistId, prevPlaylistId) => {
      const nextId = String(nextPlaylistId || '').trim()
      const prevId = String(prevPlaylistId || '').trim()
      if (prevId && prevId !== nextId) {
        stemResumeBootstrappedPlaylistIdSet.delete(prevId)
        stemResumeSignatureByPlaylistId.delete(prevId)
      }
      if (nextId !== prevId) {
        stemSummary.value = createEmptyStemSummary()
        stemRuntimeProgressByTrackId.value = {}
      }
      loadMixtapeItems()
    },
    { immediate: true }
  )

  onMounted(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const playlistId = params.get('playlistId')
      const playlistPath = params.get('playlistPath')
      const playlistName = params.get('playlistName')
      applyPayload({
        playlistId: playlistId || undefined,
        playlistPath: playlistPath ? decodeURIComponent(playlistPath) : undefined,
        playlistName: playlistName ? decodeURIComponent(playlistName) : undefined
      })
    } catch {}
    window.electron.ipcRenderer.on('mixtape-open', handleOpen)
    window.electron.ipcRenderer.on('mixtape-bpm-batch-ready', handleBpmBatchReady)
    window.electron.ipcRenderer.on('mixtape-stem-status-updated', handleMixtapeStemStatusUpdated)
    window.electron.ipcRenderer.on('mixtape-stem-cpu-slow-hint', handleMixtapeStemCpuSlowHint)
    window.electron.ipcRenderer.on('mixtape-stem-runtime-progress', handleMixtapeStemRuntimeProgress)
    window.electron.ipcRenderer.on('mixtape-output:progress', handleMixtapeOutputProgress)
    window.electron.ipcRenderer.on('mixtapeWindow-max', (_e, next: boolean) => {
      runtime.isWindowMaximized = !!next
    })
    emitter.on('playlistContentChanged', handlePlaylistContentChanged)
    window.addEventListener('pointerdown', handleGlobalPointerDown, true)
    window.addEventListener('keydown', handleWindowKeydown)
  })

  onBeforeUnmount(() => {
    try {
      window.electron.ipcRenderer.removeListener('mixtape-open', handleOpen)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-bpm-batch-ready', handleBpmBatchReady)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-stem-status-updated',
        handleMixtapeStemStatusUpdated
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-stem-cpu-slow-hint',
        handleMixtapeStemCpuSlowHint
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-stem-runtime-progress',
        handleMixtapeStemRuntimeProgress
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-output:progress',
        handleMixtapeOutputProgress
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeAllListeners('mixtapeWindow-max')
    } catch {}
    try {
      emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    } catch {}
    try {
      window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
    } catch {}
    try {
      window.removeEventListener('keydown', handleWindowKeydown)
    } catch {}
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
      playlistUpdateTimer = null
    }
    clearBpmAnalysisFailedTimer()
  })

  return {
    t,
    titleLabel,
    mixtapePlaylistId,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeMenus,
    handleTitleOpenDialog,
    mixtapeRawItems,
    tracks,
    laneIndices,
    laneHeight,
    laneTracks,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    resolveTrackTitleWithOriginalMeta,
    formatTrackBpm,
    formatTrackKey,
    formatTrackOriginalMeta,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
    handleTrackDragStart,
    handleTrackContextMenu,
    trackContextMenuVisible,
    trackContextMenuStyle,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    trackMenuMasterTempoChecked,
    beatAlignDialogVisible,
    beatAlignTrack,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    followPlayheadEnabled,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    transportError,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    bpmAnalysisFailedAutoCloseSeconds,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    outputDialogVisible,
    outputPath,
    outputFormat,
    outputFilename,
    outputStemProfile,
    shouldShowOutputStemProfileSelect,
    outputRunning,
    outputProgressText,
    outputProgressPercent,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    stemSeparationProgressVisible,
    stemSeparationProgressPercent,
    stemSeparationProgressText,
    stemSeparationRunningProgressLines,
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainReferenceOptions,
    autoGainBusy,
    autoGainProgressText,
    canStartAutoGain,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference
  }
}
