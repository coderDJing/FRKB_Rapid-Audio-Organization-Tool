import { computed, ref, type Ref } from 'vue'
import { normalizeMixtapeFilePath } from '@renderer/composables/mixtape/mixtapeTrackSnapshot'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel
} from '@shared/mixtapeStemProfiles'
import type {
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeStemMode,
  MixtapeStemProfile as RendererMixtapeStemProfile,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

type TranslateFn = (key: string, params?: Record<string, unknown>) => string

type ConfirmDialogFn = typeof import('@renderer/components/confirmDialog').default

export type MixtapeStemSummary = {
  pending: number
  running: number
  ready: number
  failed: number
}

export type StemRuntimeProgressEntry = {
  itemId: string
  filePath: string
  device: string
  percent: number
  processedSec: number | null
  totalSec: number | null
  updatedAt: number
}

export type StemRuntimeDownloadState = {
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
  error: string
  state: StemRuntimeDownloadState
}

type CreateUseMixtapeStemRuntimeModuleOptions = {
  payload: Ref<MixtapeOpenPayload>
  tracks: Ref<MixtapeTrack[]>
  mixtapeMixMode: Ref<MixtapeMixMode>
  mixtapeStemProfile: Ref<RendererMixtapeStemProfile>
  resolveTrackTitle: (track: MixtapeTrack) => string
  t: TranslateFn
  confirmDialog: ConfirmDialogFn
}

const STEM_RUNTIME_PROGRESS_MAX_VISIBLE_ITEMS = 6

export const createEmptyStemSummary = (): MixtapeStemSummary => ({
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

export const createUseMixtapeStemRuntimeModule = (
  options: CreateUseMixtapeStemRuntimeModuleOptions
) => {
  const stemSummary = ref<MixtapeStemSummary>(createEmptyStemSummary())
  const stemRuntimeProgressByTrackId = ref<Record<string, StemRuntimeProgressEntry>>({})
  const stemRuntimeDownloadState = ref<StemRuntimeDownloadState>(
    createEmptyStemRuntimeDownloadState()
  )
  const stemResumeBootstrappedPlaylistIdSet = new Set<string>()
  const stemResumeSignatureByPlaylistId = new Map<string, string>()
  const stemCpuSlowHintShownPlaylistIdSet = new Set<string>()
  const stemRuntimeDownloadAttemptedKeySet = new Set<string>()
  const stemRuntimeFailureNoticeKeyByPlaylistId = new Map<string, string>()

  let stemRuntimeDownloadAttemptBusy = false

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
    if (!normalized) return options.t('tracks.unknownTrack')
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
    if (options.mixtapeMixMode.value !== 'stem') return false
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
      return options.t('mixtape.stemSeparationProgressTextWithFailed', {
        percent,
        done,
        total,
        running,
        pending,
        failed
      })
    }
    return options.t('mixtape.stemSeparationProgressText', {
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
      options.tracks.value.map((track, index) => {
        const trackId = typeof track?.id === 'string' ? track.id.trim() : ''
        if (trackId && !trackIndexById.has(trackId)) {
          trackIndexById.set(trackId, index)
        }
        return [
          trackId,
          options.resolveTrackTitle(track) || resolveStemRuntimeFileName(track.filePath || '')
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
      return options.t('mixtape.stemSeparationTrackProgressText', {
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
      return options.t('mixtape.stemRuntimeDownloadTitle', {
        title: stemRuntimeDownloadState.value.title
      })
    }
    return options.t('mixtape.stemRuntimeDownloadTitleGeneric')
  })

  const stemRuntimeDownloadText = computed(() => {
    const state = stemRuntimeDownloadState.value
    if (state.status === 'downloading') {
      const totalBytes = state.totalBytes || state.archiveSize
      if (totalBytes > 0) {
        return options.t('mixtape.stemRuntimeDownloadProgressText', {
          downloaded: formatStemRuntimeBytes(state.downloadedBytes),
          total: formatStemRuntimeBytes(totalBytes),
          percent: stemRuntimeDownloadPercent.value
        })
      }
    }
    if (state.status === 'extracting') {
      return options.t('mixtape.stemRuntimeExtractingText')
    }
    return (
      state.message ||
      options.t('mixtape.stemRuntimeDownloadProgressText', {
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

  const handlePlaylistIdChange = (nextPlaylistId: unknown, prevPlaylistId: unknown) => {
    const nextId = String(nextPlaylistId || '').trim()
    const prevId = String(prevPlaylistId || '').trim()
    if (prevId && prevId !== nextId) {
      stemResumeBootstrappedPlaylistIdSet.delete(prevId)
      stemResumeSignatureByPlaylistId.delete(prevId)
      stemRuntimeFailureNoticeKeyByPlaylistId.delete(prevId)
    }
    if (nextId !== prevId) {
      stemSummary.value = createEmptyStemSummary()
      stemRuntimeProgressByTrackId.value = {}
    }
  }

  const resetStemResumeStateOnReopen = (nextPlaylistId: string, currentPlaylistId: string) => {
    if (!nextPlaylistId || nextPlaylistId !== currentPlaylistId) return
    stemResumeBootstrappedPlaylistIdSet.delete(nextPlaylistId)
    stemResumeSignatureByPlaylistId.delete(nextPlaylistId)
    console.info('[mixtape] stem auto resume reset on reopen', {
      playlistId: nextPlaylistId
    })
  }

  const maybeAutoDownloadStemRuntime = async (info: StemRuntimeDownloadInfo | null) => {
    const playlistId = String(options.payload.value.playlistId || '').trim()
    if (!playlistId || options.mixtapeMixMode.value !== 'stem') return
    if (
      stemRuntimeDownloadState.value.status === 'downloading' ||
      stemRuntimeDownloadState.value.status === 'extracting' ||
      stemRuntimeDownloadState.value.status === 'ready'
    ) {
      return
    }
    if (!info?.supported || !info.downloadable || info.alreadyAvailable) return
    if (!info.profile) return
    if (stemRuntimeDownloadAttemptBusy) return
    const attemptKey = `${info.profile}::${info.version}`
    if (stemRuntimeDownloadAttemptedKeySet.has(attemptKey)) return
    stemRuntimeDownloadAttemptedKeySet.add(attemptKey)
    stemRuntimeDownloadAttemptBusy = true
    try {
      const response = await window.electron.ipcRenderer.invoke(
        'mixtape:stem:runtime:download-preferred'
      )
      stemRuntimeDownloadState.value = normalizeStemRuntimeDownloadState(response?.state)
    } catch (error) {
      console.error('[mixtape] runtime download prompt failed', {
        playlistId,
        profile: info.profile,
        version: info.version,
        error
      })
    } finally {
      stemRuntimeDownloadAttemptBusy = false
    }
  }

  const refreshStemRuntimeDownloadStatus = async () => {
    const playlistId = String(options.payload.value.playlistId || '').trim()
    if (!playlistId || options.mixtapeMixMode.value !== 'stem') return
    try {
      const response = await window.electron.ipcRenderer.invoke('mixtape:stem:runtime:get-status')
      stemRuntimeDownloadState.value = normalizeStemRuntimeDownloadState(response?.state)
      const preferred =
        response?.preferred && typeof response.preferred === 'object'
          ? (response.preferred as StemRuntimeDownloadInfo)
          : null
      if (preferred?.reason === 'manifest unavailable') {
        const failureKey = [
          'manifest',
          preferred.profile,
          preferred.version,
          preferred.error || preferred.manifestUrl
        ].join('::')
        stemRuntimeDownloadState.value = {
          ...stemRuntimeDownloadState.value,
          status: 'failed',
          profile: preferred.profile || stemRuntimeDownloadState.value.profile,
          runtimeKey: preferred.runtimeKey || stemRuntimeDownloadState.value.runtimeKey,
          version: preferred.version || stemRuntimeDownloadState.value.version,
          archiveSize: preferred.archiveSize || stemRuntimeDownloadState.value.archiveSize,
          title: preferred.title || stemRuntimeDownloadState.value.title,
          message: options.t('mixtape.stemRuntimeManifestUnavailableHint'),
          error: preferred.error || stemRuntimeDownloadState.value.error,
          updatedAt: Date.now()
        }
        if (stemRuntimeFailureNoticeKeyByPlaylistId.get(playlistId) !== failureKey) {
          stemRuntimeFailureNoticeKeyByPlaylistId.set(playlistId, failureKey)
          const content = [
            options.t('mixtape.stemRuntimeManifestUnavailableHint'),
            options.t('mixtape.stemRuntimeNetworkHint'),
            options.t('mixtape.stemRuntimeDownloadFailedCloseHint')
          ]
          if (preferred.error) {
            content.push(
              options.t('mixtape.stemRuntimeDownloadErrorHint', { error: preferred.error })
            )
          }
          void (async () => {
            await options.confirmDialog({
              title: options.t('common.warning'),
              content,
              confirmShow: false,
              textAlign: 'left',
              innerWidth: 560,
              innerHeight: 0
            })
            window.electron.ipcRenderer.send('mixtapeWindow-toggle-close')
          })()
        }
        return
      }
      await maybeAutoDownloadStemRuntime(preferred)
    } catch (error) {
      console.error('[mixtape] refresh stem runtime download status failed', {
        playlistId,
        error
      })
    }
  }

  const autoResumePendingStemJobs = async (params: {
    playlistId: string
    stemMode: MixtapeStemMode
    trackList: MixtapeTrack[]
    includeRunning: boolean
  }) => {
    const playlistId = String(params.playlistId || '').trim()
    if (!playlistId || !window?.electron?.ipcRenderer?.invoke) return
    await refreshStemRuntimeDownloadStatus()
    const runtimeStatus = stemRuntimeDownloadState.value.status
    if (
      runtimeStatus === 'available' ||
      runtimeStatus === 'downloading' ||
      runtimeStatus === 'extracting' ||
      runtimeStatus === 'failed'
    ) {
      stemResumeSignatureByPlaylistId.delete(playlistId)
      return
    }
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
      const parsedModel = parseMixtapeStemModel(model, options.mixtapeStemProfile.value)
      const requestedModel = parsedModel.requestedModel
      const profile = normalizeStemProfile(parsedModel.profile, options.mixtapeStemProfile.value)
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

  const handleStemStatusPayload = (eventPayload: any) => {
    const playlistId = options.payload.value.playlistId
    if (!playlistId) return false
    const targetPlaylistId =
      typeof eventPayload?.playlistId === 'string' ? eventPayload.playlistId.trim() : ''
    if (!targetPlaylistId || targetPlaylistId !== playlistId) return false
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
    return true
  }

  const handleMixtapeStemCpuSlowHint = (_e: unknown, eventPayload: any) => {
    const playlistId = String(options.payload.value.playlistId || '').trim()
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
        ? options.t('mixtape.stemCpuSlowHintReasonGpuUnavailable')
        : reasonCode === 'gpu_failed'
          ? options.t('mixtape.stemCpuSlowHintReasonGpuFailed')
          : reasonCode === 'gpu_backend_missing'
            ? options.t('mixtape.stemCpuSlowHintReasonGpuBackendMissing')
            : options.t('mixtape.stemCpuSlowHintReasonUnknown')
    const content = [
      options.t('mixtape.stemCpuSlowHintReasonLine', { reason: reasonText }),
      options.t('mixtape.stemCpuSlowHint')
    ]
    const reasonDetail =
      typeof eventPayload?.reasonDetail === 'string' ? eventPayload.reasonDetail.trim() : ''
    if (reasonDetail) {
      content.splice(1, 0, options.t('mixtape.stemCpuSlowHintDetailLine', { detail: reasonDetail }))
    }
    void options.confirmDialog({
      title: options.t('common.warning'),
      content,
      confirmShow: false,
      textAlign: 'left',
      innerHeight: 0,
      innerWidth: 520
    })
  }

  const handleMixtapeStemRuntimeProgress = (_e: unknown, eventPayload: any) => {
    const playlistId = String(options.payload.value.playlistId || '').trim()
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

  const handleMixtapeStemRuntimeDownloadState = (_e: unknown, eventPayload: any) => {
    const playlistId = String(options.payload.value.playlistId || '').trim()
    const prevStatus = stemRuntimeDownloadState.value.status
    const nextState = normalizeStemRuntimeDownloadState(eventPayload)
    stemRuntimeDownloadState.value = nextState
    if (nextState.status === 'ready' && prevStatus !== 'ready' && nextState.title) {
      void options.confirmDialog({
        title: options.t('common.success'),
        content: [options.t('mixtape.stemRuntimeDownloadReadyHint', { title: nextState.title })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 480,
        innerHeight: 0
      })
      return
    }
    if (nextState.status === 'failed' && prevStatus !== 'failed') {
      const failureKey = [
        'runtime',
        nextState.profile,
        nextState.runtimeKey,
        nextState.version,
        nextState.error
      ].join('::')
      if (playlistId && stemRuntimeFailureNoticeKeyByPlaylistId.get(playlistId) === failureKey) {
        return
      }
      if (playlistId) {
        stemRuntimeFailureNoticeKeyByPlaylistId.set(playlistId, failureKey)
      }
      const content = [options.t('mixtape.stemRuntimeDownloadFailedHint')]
      content.push(options.t('mixtape.stemRuntimeDownloadFailedCloseHint'))
      if (nextState.error) {
        content.push(options.t('mixtape.stemRuntimeDownloadErrorHint', { error: nextState.error }))
      }
      void (async () => {
        await options.confirmDialog({
          title: options.t('common.warning'),
          content,
          confirmShow: false,
          textAlign: 'left',
          innerWidth: 560,
          innerHeight: 0
        })
        window.electron.ipcRenderer.send('mixtapeWindow-toggle-close')
      })()
    }
  }

  return {
    createEmptyStemSummary,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemRuntimeDownloadState,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    stemSeparationProgressVisible,
    stemSeparationProgressPercent,
    stemSeparationProgressText,
    stemSeparationRunningProgressLines,
    stemRuntimeDownloadVisible,
    stemRuntimeDownloadPercent,
    stemRuntimeDownloadTitle,
    stemRuntimeDownloadText,
    hasTrackStemPathsReady,
    resolveTrackStemModel,
    pruneStemRuntimeProgressByTracks,
    handlePlaylistIdChange,
    resetStemResumeStateOnReopen,
    refreshStemRuntimeDownloadStatus,
    autoResumePendingStemJobs,
    handleStemStatusPayload,
    handleMixtapeStemCpuSlowHint,
    handleMixtapeStemRuntimeProgress,
    handleMixtapeStemRuntimeDownloadState
  }
}
