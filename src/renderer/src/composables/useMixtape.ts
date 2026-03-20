import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import confirmDialog from '@renderer/components/confirmDialog'
import { useMixtapeTimeline } from '@renderer/composables/mixtape/useMixtapeTimeline'
import { createMixtapeAutoGainController } from '@renderer/composables/mixtape/autoGainController'
import { createUseMixtapeBpmAndUiModule } from '@renderer/composables/mixtape/useMixtapeBpmAndUiModule'
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
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
  resolveMixtapeStemModelByProfile
} from '@shared/mixtapeStemProfiles'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'
import { createClickThroughGuard } from '@renderer/utils/clickThroughGuard'
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
type StemRuntimeDownloadState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  profile: string
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}
type StemRuntimeDownloadInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: string
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  state: StemRuntimeDownloadState
}
const decodeMixtapeQueryValue = (value: string | null): string | undefined => {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
const resolveInitialMixtapePayload = (): MixtapeOpenPayload => {
  if (typeof window === 'undefined') return {}
  try {
    const params = new URLSearchParams(window.location.search)
    return {
      playlistId: params.get('playlistId') || undefined,
      playlistPath: decodeMixtapeQueryValue(params.get('playlistPath')),
      playlistName: decodeMixtapeQueryValue(params.get('playlistName'))
    }
  } catch {
    return {}
  }
}
const createEmptyStemSummary = (): MixtapeStemSummary => ({
  pending: 0,
  running: 0,
  ready: 0,
  failed: 0
})
const createEmptyStemRuntimeDownloadState = (): StemRuntimeDownloadState => ({
  status: 'idle',
  profile: '',
  runtimeKey: '',
  version: '',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  title: '',
  message: '',
  error: '',
  updatedAt: 0
})
const STEM_RUNTIME_PROGRESS_MAX_VISIBLE_ITEMS = 6
export const useMixtape = () => {
  const contextMenuClickThroughGuard = createClickThroughGuard()
  const CONTEXT_MENU_SELECTOR = '[data-frkb-context-menu="true"]'
  const payload = ref<MixtapeOpenPayload>(resolveInitialMixtapePayload())
  const mixtapeMixMode = ref<MixtapeMixMode>('stem')
  const mixtapeStemMode = ref<MixtapeStemMode>(FIXED_MIXTAPE_STEM_MODE)
  const mixtapeStemProfile = ref<RendererMixtapeStemProfile>(DEFAULT_MIXTAPE_STEM_PROFILE)
  const tracks = ref<MixtapeTrack[]>([])
  const mixtapeRawItems = ref<MixtapeRawItem[]>([])
  const mixtapeItemsLoading = ref(!!payload.value.playlistId)
  const selectedTrackId = ref('')
  const runtime = useRuntimeStore()
  const outputPath = ref('')
  const outputFormat = ref<'wav' | 'mp3'>('wav')
  const outputFilename = ref(buildRecFilename())
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
  const bpmAnalysisFailedReason = ref('')
  const stemSummary = ref<MixtapeStemSummary>(createEmptyStemSummary())
  const stemRuntimeProgressByTrackId = ref<Record<string, StemRuntimeProgressEntry>>({})
  const stemRuntimeDownloadState = ref<StemRuntimeDownloadState>(
    createEmptyStemRuntimeDownloadState()
  )
  const stemResumeBootstrappedPlaylistIdSet = new Set<string>()
  const stemResumeSignatureByPlaylistId = new Map<string, string>()
  const stemCpuSlowHintShownPlaylistIdSet = new Set<string>()
  const stemRuntimeDownloadPromptedKeySet = new Set<string>()
  let stemRuntimeDownloadPromptBusy = false
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
    resolveTrackSourceDurationSeconds,
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
    playheadSec,
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
    value === 'eq' ? 'eq' : 'stem'
  const normalizeMixtapeStemMode = (_value: unknown): MixtapeStemMode => FIXED_MIXTAPE_STEM_MODE
  const normalizeStemProfile = (
    value: unknown,
    fallback: RendererMixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
  ): RendererMixtapeStemProfile => normalizeMixtapeStemProfile(value, fallback)
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
  const normalizeStemRuntimeDownloadStatus = (
    value: unknown
  ): StemRuntimeDownloadState['status'] => {
    return value === 'available' ||
      value === 'downloading' ||
      value === 'extracting' ||
      value === 'ready' ||
      value === 'failed'
      ? value
      : 'idle'
  }
  const normalizeStemRuntimeDownloadState = (value: unknown): StemRuntimeDownloadState => {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    return {
      status: normalizeStemRuntimeDownloadStatus(raw.status),
      profile: typeof raw.profile === 'string' ? raw.profile.trim() : '',
      runtimeKey: typeof raw.runtimeKey === 'string' ? raw.runtimeKey.trim() : '',
      version: typeof raw.version === 'string' ? raw.version.trim() : '',
      percent: normalizeStemRuntimePercent(raw.percent),
      downloadedBytes: Math.max(0, Number(raw.downloadedBytes) || 0),
      totalBytes: Math.max(0, Number(raw.totalBytes) || 0),
      archiveSize: Math.max(0, Number(raw.archiveSize) || 0),
      title: typeof raw.title === 'string' ? raw.title.trim() : '',
      message: typeof raw.message === 'string' ? raw.message.trim() : '',
      error: typeof raw.error === 'string' ? raw.error.trim() : '',
      updatedAt: Math.max(0, Math.floor(Number(raw.updatedAt) || 0))
    }
  }
  const formatStemRuntimeBytes = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = Math.max(0, Number(bytes) || 0)
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    const digits = unitIndex === 0 ? 0 : unitIndex === 1 ? 1 : 2
    return `${value.toFixed(digits)} ${units[unitIndex]}`
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
      trackList
        .map((track) => (typeof track?.id === 'string' ? track.id.trim() : ''))
        .filter(Boolean)
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
        return [
          trackId,
          resolveTrackTitle(track) || resolveStemRuntimeFileName(track.filePath || '')
        ]
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
  const stemRuntimeDownloadVisible = computed(() => {
    const status = stemRuntimeDownloadState.value.status
    return status === 'downloading' || status === 'extracting'
  })
  const stemRuntimeDownloadPercent = computed(() =>
    Math.max(0, Math.min(100, normalizeStemRuntimePercent(stemRuntimeDownloadState.value.percent)))
  )
  const stemRuntimeDownloadTitle = computed(() => {
    if (stemRuntimeDownloadState.value.title) {
      return t('mixtape.stemRuntimeDownloadTitle', {
        title: stemRuntimeDownloadState.value.title
      })
    }
    return t('mixtape.stemRuntimeDownloadTitleGeneric')
  })
  const stemRuntimeDownloadText = computed(() => {
    const state = stemRuntimeDownloadState.value
    if (state.status === 'downloading') {
      const totalBytes = state.totalBytes || state.archiveSize
      if (totalBytes > 0) {
        return t('mixtape.stemRuntimeDownloadProgressText', {
          downloaded: formatStemRuntimeBytes(state.downloadedBytes),
          total: formatStemRuntimeBytes(totalBytes),
          percent: stemRuntimeDownloadPercent.value
        })
      }
    }
    if (state.status === 'extracting') {
      return t('mixtape.stemRuntimeExtractingText')
    }
    return (
      state.message ||
      t('mixtape.stemRuntimeDownloadProgressText', {
        downloaded: formatStemRuntimeBytes(state.downloadedBytes),
        total: formatStemRuntimeBytes(state.totalBytes || state.archiveSize),
        percent: stemRuntimeDownloadPercent.value
      })
    )
  })
  const resolveTrackStemModel = (track: MixtapeTrack) =>
    typeof track?.stemModel === 'string' ? track.stemModel.trim() : ''
  const resolveTrackStemVersion = (track: MixtapeTrack) =>
    typeof track?.stemVersion === 'string' ? track.stemVersion.trim() : ''
  const hasTrackStemPathsReady = (track: MixtapeTrack, _stemMode: MixtapeStemMode) => {
    const vocalPath = normalizeMixtapeFilePath((track as any)?.stemVocalPath)
    const instPath = normalizeMixtapeFilePath((track as any)?.stemInstPath)
    const bassPath = normalizeMixtapeFilePath((track as any)?.stemBassPath)
    const drumsPath = normalizeMixtapeFilePath((track as any)?.stemDrumsPath)
    if (!vocalPath || !instPath || !bassPath || !drumsPath) return false
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
    return `${baseTitle} (${originalMeta})`
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
  }) => {
    const playlistId = String(params.playlistId || '').trim()
    if (!playlistId || !window?.electron?.ipcRenderer?.invoke) return
    const includeRunning = !!params.includeRunning
    const resumeCandidates = params.trackList.filter((track) => {
      const status = normalizeMixtapeStemStatus(track.stemStatus)
      if (status === 'pending') return true
      if (includeRunning && status === 'running') return true
      if (status === 'failed') return true
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
      const parsedModel = parseMixtapeStemModel(model, mixtapeStemProfile.value)
      const requestedModel = parsedModel.requestedModel
      const profile = normalizeStemProfile(parsedModel.profile, mixtapeStemProfile.value)
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
  // BPM銆佽彍鍗曚笌瀵煎嚭閫昏緫宸叉媶鍒嗗埌 useMixtapeBpmAndUiModule
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
  const {
    handleBpmBatchReady,
    clearBpmAnalysisFailedTimer,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    loadMixtapeItems,
    closeTrackContextMenu,
    handleTrackContextMenu,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    handleTrackMenuRemoveFromMixtape,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    handleGlobalPointerDown,
    handleWindowKeydown,
    openOutputDialog,
    applyOutputProgressPayload,
    handleOutputDialogConfirm,
    handleOutputDialogCancel
  } = createUseMixtapeBpmAndUiModule({
    payload,
    tracks,
    mixtapeRawItems,
    mixtapeItemsLoading,
    selectedTrackId,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeStemProfile,
    outputDialogVisible,
    outputRunning,
    outputPath,
    outputFormat,
    outputFilename,
    outputProgressKey,
    outputProgressPercent,
    outputProgressDone,
    outputProgressTotal,
    trackContextMenuVisible,
    trackContextMenuX,
    trackContextMenuY,
    trackContextTrackId,
    beatAlignDialogVisible,
    beatAlignTrackId,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    bpmAnalysisFailedReason,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    autoGainDialogVisible,
    transportPlaying,
    transportDecoding,
    createEmptyStemSummary,
    applyBpmAnalysisToTracks,
    buildBpmTargets,
    resolveMissingBpmCount,
    buildMixtapeBpmTargetKey,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackTitle,
    renderMixtapeOutputWav,
    normalizeMixtapeFilePath,
    normalizeMixtapeMixMode,
    normalizeMixtapeStemMode,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    normalizeUniquePaths,
    parseSnapshot,
    hasTrackStemPathsReady,
    autoResumePendingStemJobs,
    pruneStemRuntimeProgressByTracks,
    resolveTrackStemModel,
    syncAutoGainReferenceTrack,
    resetAutoGainState,
    notifyMissingTracksRemoved,
    resolveMixtapeStemModelByProfile,
    resolveMixtapeOutputProgressState,
    normalizeBarBeatOffset,
    normalizeFirstBeatMs,
    normalizeBpm,
    MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
    MIXTAPE_ENVELOPE_PARAMS_STEM,
    MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
    buildFlatMixEnvelope,
    normalizeMixEnvelopePoints,
    DEFAULT_MIXTAPE_STEM_PROFILE,
    confirmDialog,
    t,
    handleTransportStop,
    handleTransportPlayFromStart
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
  const handleMixtapeItemsRemoved = (_e: unknown, eventPayload: any) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId) return
    const targetPlaylistId =
      typeof eventPayload?.playlistId === 'string' ? eventPayload.playlistId.trim() : ''
    if (!targetPlaylistId || targetPlaylistId !== playlistId) return
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
    const reasonDetail =
      typeof eventPayload?.reasonDetail === 'string' ? eventPayload.reasonDetail.trim() : ''
    if (reasonDetail) {
      content.splice(1, 0, t('mixtape.stemCpuSlowHintDetailLine', { detail: reasonDetail }))
    }
    void confirmDialog({
      title: t('common.warning'),
      content,
      confirmShow: false,
      textAlign: 'left',
      innerHeight: 0,
      innerWidth: 520
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
  const maybePromptStemRuntimeDownload = async (info: StemRuntimeDownloadInfo | null) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId || mixtapeMixMode.value !== 'stem') return
    if (
      stemRuntimeDownloadState.value.status === 'downloading' ||
      stemRuntimeDownloadState.value.status === 'extracting' ||
      stemRuntimeDownloadState.value.status === 'ready'
    ) {
      return
    }
    if (!info?.supported || !info.downloadable || info.alreadyAvailable) return
    if (!info.profile || info.profile === 'cpu') return
    if (stemRuntimeDownloadPromptBusy) return
    const promptKey = `${playlistId}::${info.profile}::${info.version}`
    if (stemRuntimeDownloadPromptedKeySet.has(promptKey)) return
    stemRuntimeDownloadPromptedKeySet.add(promptKey)
    stemRuntimeDownloadPromptBusy = true
    try {
      const result = await confirmDialog({
        title: t('mixtape.stemRuntimeDownloadPromptTitle'),
        content: [
          t('mixtape.stemRuntimeDownloadPromptBody', {
            title: info.title || info.profile.toUpperCase(),
            size: formatStemRuntimeBytes(info.archiveSize)
          }),
          t('mixtape.stemRuntimeDownloadPromptHint')
        ],
        confirmShow: true,
        confirmText: t('mixtape.stemRuntimeDownloadConfirm'),
        cancelText: t('mixtape.stemRuntimeDownloadSkip'),
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
      if (result !== 'confirm') return
      const response = await window.electron.ipcRenderer.invoke(
        'mixtape:stem:runtime:download-preferred'
      )
      const nextState = normalizeStemRuntimeDownloadState(response?.state)
      stemRuntimeDownloadState.value = nextState
    } catch (error) {
      console.error('[mixtape] runtime download prompt failed', {
        playlistId,
        profile: info.profile,
        version: info.version,
        error
      })
    } finally {
      stemRuntimeDownloadPromptBusy = false
    }
  }
  const refreshStemRuntimeDownloadStatus = async () => {
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId || mixtapeMixMode.value !== 'stem') return
    try {
      const response = await window.electron.ipcRenderer.invoke('mixtape:stem:runtime:get-status')
      stemRuntimeDownloadState.value = normalizeStemRuntimeDownloadState(response?.state)
      const preferred =
        response?.preferred && typeof response.preferred === 'object'
          ? (response.preferred as StemRuntimeDownloadInfo)
          : null
      await maybePromptStemRuntimeDownload(preferred)
    } catch (error) {
      console.error('[mixtape] refresh stem runtime download status failed', {
        playlistId,
        error
      })
    }
  }
  const handleMixtapeStemRuntimeDownloadState = (_e: unknown, eventPayload: any) => {
    const prevStatus = stemRuntimeDownloadState.value.status
    const nextState = normalizeStemRuntimeDownloadState(eventPayload)
    stemRuntimeDownloadState.value = nextState
    if (nextState.status === 'ready' && prevStatus !== 'ready' && nextState.title) {
      void confirmDialog({
        title: t('common.success'),
        content: [t('mixtape.stemRuntimeDownloadReadyHint', { title: nextState.title })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 480,
        innerHeight: 0
      })
      return
    }
    if (nextState.status === 'failed' && prevStatus !== 'failed') {
      const content = [t('mixtape.stemRuntimeDownloadFailedHint')]
      if (nextState.error) {
        content.push(t('mixtape.stemRuntimeDownloadErrorHint', { error: nextState.error }))
      }
      void confirmDialog({
        title: t('common.warning'),
        content,
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
    }
  }
  const handleOpen = (_e: any, next: MixtapeOpenPayload) => {
    if (!next || typeof next !== 'object') return
    const currentPlaylistId = String(payload.value.playlistId || '').trim()
    const nextPlaylistId = String(next.playlistId || '').trim()
    if (nextPlaylistId && nextPlaylistId === currentPlaylistId) {
      stemResumeBootstrappedPlaylistIdSet.delete(nextPlaylistId)
      stemResumeSignatureByPlaylistId.delete(nextPlaylistId)
      console.info('[mixtape] stem auto resume reset on reopen', {
        playlistId: nextPlaylistId
      })
    }
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

  const hasOpenContextMenu = () => {
    return !!document.querySelector(CONTEXT_MENU_SELECTOR)
  }

  const isInsideContextMenu = (target: EventTarget | null) => {
    const element = target as Element | null
    if (!element) return false
    return !!element.closest(CONTEXT_MENU_SELECTOR)
  }

  const handleContextMenuPointerDownCapture = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (!hasOpenContextMenu()) return
    if (isInsideContextMenu(event.target)) return
    contextMenuClickThroughGuard.markFromPointer(event)
    event.preventDefault()
    event.stopPropagation()
  }

  const handleContextMenuClickCapture = (event: MouseEvent) => {
    contextMenuClickThroughGuard.suppressClickIfNeeded(event)
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
  watch(
    [mixtapePlaylistId, mixtapeMixMode],
    async ([nextPlaylistId, nextMixMode]) => {
      if (!String(nextPlaylistId || '').trim()) return
      if (nextMixMode !== 'stem') return
      await nextTick()
      void refreshStemRuntimeDownloadStatus()
    },
    { immediate: true }
  )
  onMounted(() => {
    applyPayload(resolveInitialMixtapePayload())
    window.electron.ipcRenderer.on('mixtape-open', handleOpen)
    window.electron.ipcRenderer.on('mixtape-bpm-batch-ready', handleBpmBatchReady)
    window.electron.ipcRenderer.on('mixtape-stem-status-updated', handleMixtapeStemStatusUpdated)
    window.electron.ipcRenderer.on('mixtape-stem-cpu-slow-hint', handleMixtapeStemCpuSlowHint)
    window.electron.ipcRenderer.on(
      'mixtape-stem-runtime-progress',
      handleMixtapeStemRuntimeProgress
    )
    window.electron.ipcRenderer.on(
      'mixtape-stem-runtime-download-state',
      handleMixtapeStemRuntimeDownloadState
    )
    window.electron.ipcRenderer.on('mixtape-output:progress', handleMixtapeOutputProgress)
    window.electron.ipcRenderer.on('mixtape-items-removed', handleMixtapeItemsRemoved)
    window.electron.ipcRenderer.on('mixtapeWindow-max', (_e, next: boolean) => {
      runtime.isWindowMaximized = !!next
    })
    emitter.on('playlistContentChanged', handlePlaylistContentChanged)
    window.addEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
    window.addEventListener('click', handleContextMenuClickCapture, true)
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
        'mixtape-stem-runtime-download-state',
        handleMixtapeStemRuntimeDownloadState
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-output:progress',
        handleMixtapeOutputProgress
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-items-removed', handleMixtapeItemsRemoved)
    } catch {}
    try {
      window.electron.ipcRenderer.removeAllListeners('mixtapeWindow-max')
    } catch {}
    try {
      emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    } catch {}
    try {
      window.removeEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
    } catch {}
    try {
      window.removeEventListener('click', handleContextMenuClickCapture, true)
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
    contextMenuClickThroughGuard.clear()
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
    mixtapeItemsLoading,
    tracks,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    laneIndices,
    laneHeight,
    laneTracks,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
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
    handleTrackMenuRemoveFromMixtape,
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
    playheadSec,
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
    bpmAnalysisFailedReason,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    outputDialogVisible,
    outputPath,
    outputFormat,
    outputFilename,
    outputRunning,
    outputProgressText,
    outputProgressPercent,
    stemRuntimeDownloadVisible,
    stemRuntimeDownloadPercent,
    stemRuntimeDownloadTitle,
    stemRuntimeDownloadText,
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
