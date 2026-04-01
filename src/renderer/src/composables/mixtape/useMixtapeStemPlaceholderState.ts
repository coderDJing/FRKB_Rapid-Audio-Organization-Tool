import { computed, type Ref } from 'vue'
import type {
  MixtapeMixMode,
  MixtapeStemStatus,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'
import type { StemRuntimeProgressEntry } from '@renderer/composables/mixtape/useMixtapeStemRuntimeModule'

type TranslateFn = (key: string, payload?: Record<string, unknown>) => string

export type TrackStemPlaceholderState = {
  kind: 'pending' | 'running' | 'failed'
  label: string
  detail: string
  percent: number | null
}

type UseMixtapeStemPlaceholderStateOptions = {
  mixtapeMixMode: Ref<MixtapeMixMode>
  tracks: Ref<MixtapeTrack[]>
  stemRetryingTrackIdMap: Ref<Record<string, boolean>>
  stemRuntimeProgressByTrackId: Ref<Record<string, StemRuntimeProgressEntry>>
  t: TranslateFn
}

const normalizeTrackStemStatus = (value: unknown): MixtapeStemStatus => {
  if (value === 'pending' || value === 'running' || value === 'ready' || value === 'failed') {
    return value
  }
  return 'ready'
}

const hasTrackStemAssetsReady = (track: MixtapeTrack) =>
  Boolean(
    String(track.stemVocalPath || '').trim() &&
      String(track.stemInstPath || '').trim() &&
      String(track.stemBassPath || '').trim() &&
      String(track.stemDrumsPath || '').trim()
  )

const clampStemProgressPercent = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

const formatStemRuntimeTime = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return '--:--'
  const totalSeconds = Math.floor(numeric)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export const useMixtapeStemPlaceholderState = ({
  mixtapeMixMode,
  tracks,
  stemRetryingTrackIdMap,
  stemRuntimeProgressByTrackId,
  t
}: UseMixtapeStemPlaceholderStateOptions) =>
  computed<Record<string, TrackStemPlaceholderState>>(() => {
    const next: Record<string, TrackStemPlaceholderState> = {}
    if (mixtapeMixMode.value !== 'stem') return next
    for (const track of tracks.value) {
      const trackId = String(track?.id || '').trim()
      if (!trackId) continue
      if (stemRetryingTrackIdMap.value[trackId]) {
        next[trackId] = {
          kind: 'pending',
          label: t('mixtape.stemTrackRetrying'),
          detail: t('mixtape.stemTrackSilentHint'),
          percent: null
        }
        continue
      }
      const stemStatus = normalizeTrackStemStatus(track.stemStatus)
      const stemAssetsReady = hasTrackStemAssetsReady(track)
      if (stemStatus === 'ready' && stemAssetsReady) continue

      if (stemStatus === 'failed') {
        const failureDetail =
          typeof track.stemError === 'string' && track.stemError.trim()
            ? track.stemError.trim()
            : t('mixtape.stemTrackFailedHint')
        next[trackId] = {
          kind: 'failed',
          label: t('mixtape.stemTrackStatusFailed'),
          detail: failureDetail,
          percent: null
        }
        continue
      }

      if (stemStatus === 'running') {
        const runtimeProgress = stemRuntimeProgressByTrackId.value[trackId]
        const percent = clampStemProgressPercent(runtimeProgress?.percent)
        const device =
          typeof runtimeProgress?.device === 'string' && runtimeProgress.device.trim()
            ? runtimeProgress.device.trim().toUpperCase()
            : 'CPU'
        const processed = formatStemRuntimeTime(runtimeProgress?.processedSec)
        const total = formatStemRuntimeTime(runtimeProgress?.totalSec)
        next[trackId] = {
          kind: 'running',
          label: t('mixtape.stemTrackStatusRunning', { percent }),
          detail: t('mixtape.stemTrackRunningHint', { device, processed, total }),
          percent
        }
        continue
      }

      next[trackId] = {
        kind: 'pending',
        label: t(
          stemStatus === 'ready' && !stemAssetsReady
            ? 'mixtape.stemTrackStatusPreparing'
            : 'mixtape.stemTrackStatusQueued'
        ),
        detail: t('mixtape.stemTrackSilentHint'),
        percent: null
      }
    }
    return next
  })
