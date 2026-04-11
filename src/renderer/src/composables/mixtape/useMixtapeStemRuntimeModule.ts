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

type CreateUseMixtapeStemRuntimeModuleOptions = {
  payload: Ref<MixtapeOpenPayload>
  tracks: Ref<MixtapeTrack[]>
  mixtapeMixMode: Ref<MixtapeMixMode>
  mixtapeStemProfile: Ref<RendererMixtapeStemProfile>
  resolveTrackTitle: (track: MixtapeTrack) => string
  t: TranslateFn
  confirmDialog: ConfirmDialogFn
}

type StemStatusPayload = {
  playlistId?: string
  stemStatus?: unknown
  itemIds?: unknown[]
  stemSummary?: unknown
}

type StemCpuSlowHintPayload = {
  playlistId?: string
  reasonCode?: string
  reasonDetail?: string
}

type StemRuntimeProgressPayload = {
  playlistId?: string
  itemIds?: unknown[]
  percent?: unknown
  processedSec?: unknown
  totalSec?: unknown
  filePath?: unknown
  device?: string
}

const STEM_RUNTIME_PROGRESS_MAX_VISIBLE_ITEMS = 6

export const createEmptyStemSummary = (): MixtapeStemSummary => ({
  pending: 0,
  running: 0,
  ready: 0,
  failed: 0
})

export const createUseMixtapeStemRuntimeModule = (
  options: CreateUseMixtapeStemRuntimeModuleOptions
) => {
  const stemSummary = ref<MixtapeStemSummary>(createEmptyStemSummary())
  const stemRuntimeProgressByTrackId = ref<Record<string, StemRuntimeProgressEntry>>({})
  const stemResumeBootstrappedPlaylistIdSet = new Set<string>()
  const stemResumeSignatureByPlaylistId = new Map<string, string>()
  const stemCpuSlowHintShownPlaylistIdSet = new Set<string>()

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

  const resolveTrackStemModel = (track: MixtapeTrack) =>
    typeof track?.stemModel === 'string' ? track.stemModel.trim() : ''

  const resolveTrackStemVersion = (track: MixtapeTrack) =>
    typeof track?.stemVersion === 'string' ? track.stemVersion.trim() : ''

  const hasTrackStemPathsReady = (track: MixtapeTrack, _stemMode: MixtapeStemMode) => {
    const vocalPath = normalizeMixtapeFilePath(track?.stemVocalPath)
    const instPath = normalizeMixtapeFilePath(track?.stemInstPath)
    const bassPath = normalizeMixtapeFilePath(track?.stemBassPath)
    const drumsPath = normalizeMixtapeFilePath(track?.stemDrumsPath)
    if (!vocalPath || !instPath || !bassPath || !drumsPath) return false
    return true
  }

  const handlePlaylistIdChange = (nextPlaylistId: unknown, prevPlaylistId: unknown) => {
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
  }

  const resetStemResumeStateOnReopen = (nextPlaylistId: string, currentPlaylistId: string) => {
    if (!nextPlaylistId || nextPlaylistId !== currentPlaylistId) return
    stemResumeBootstrappedPlaylistIdSet.delete(nextPlaylistId)
    stemResumeSignatureByPlaylistId.delete(nextPlaylistId)
    console.info('[mixtape] stem auto resume reset on reopen', {
      playlistId: nextPlaylistId
    })
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

  const handleStemStatusPayload = (payload: unknown) => {
    const eventPayload = (
      payload && typeof payload === 'object' ? payload : null
    ) as StemStatusPayload | null
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

  const handleMixtapeStemCpuSlowHint = (
    _e: unknown,
    eventPayload: StemCpuSlowHintPayload | null
  ) => {
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

  const handleMixtapeStemRuntimeProgress = (
    _e: unknown,
    eventPayload: StemRuntimeProgressPayload | null
  ) => {
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

  return {
    createEmptyStemSummary,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    stemSeparationProgressVisible,
    stemSeparationProgressPercent,
    stemSeparationProgressText,
    stemSeparationRunningProgressLines,
    hasTrackStemPathsReady,
    resolveTrackStemModel,
    pruneStemRuntimeProgressByTracks,
    handlePlaylistIdChange,
    resetStemResumeStateOnReopen,
    autoResumePendingStemJobs,
    handleStemStatusPayload,
    handleMixtapeStemCpuSlowHint,
    handleMixtapeStemRuntimeProgress
  }
}
