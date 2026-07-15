import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import {
  PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  PREVIEW_BPM_TAP_RESET_MS,
  normalizeBeatOffset
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { buildHorizontalBrowseRawWaveformGridSignature } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformGridSignature'
import {
  createSongBeatGridMapV2FromFixedGrid,
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from '@shared/songBeatGridMapV2'

type HorizontalBrowseDetailGridPersistenceParams = {
  song: () => ISongInfo | null
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewDownbeatBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
  previewBeatGridMap?: Ref<SongBeatGridMapV2 | null>
  resolvePreviewDurationSec?: () => number
  bpmTapTimestamps: Ref<number[]>
}

export const createHorizontalBrowseDetailGridPersistence = (
  params: HorizontalBrowseDetailGridPersistenceParams
) => {
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
  let pendingLocalGridSignature = ''
  let pendingLocalGridStartedAt = 0
  const PENDING_LOCAL_GRID_SYNC_HOLD_MS = 5000

  const clearPersistTimer = () => {
    if (!persistTimer) return
    clearTimeout(persistTimer)
    persistTimer = null
  }

  const clearBpmTapResetTimer = () => {
    if (!bpmTapResetTimer) return
    clearTimeout(bpmTapResetTimer)
    bpmTapResetTimer = null
  }

  const buildPreviewGridSignature = () =>
    buildHorizontalBrowseRawWaveformGridSignature({
      bpm: params.previewBpm.value,
      firstBeatMs: params.previewFirstBeatMs.value,
      downbeatBeatOffset: params.previewDownbeatBeatOffset.value,
      timeBasisOffsetMs: params.previewTimeBasisOffsetMs.value,
      beatGridMapSignature: params.previewBeatGridMap?.value?.signature
    })

  const buildSongGridSignature = () =>
    buildHorizontalBrowseRawWaveformGridSignature({
      bpm: params.song()?.bpm,
      firstBeatMs: params.song()?.firstBeatMs,
      downbeatBeatOffset: params.song()?.downbeatBeatOffset,
      timeBasisOffsetMs: params.song()?.timeBasisOffsetMs,
      beatGridMapSignature: params.song()?.beatGridMap?.signature
    })

  const resetPreviewBpmTap = () => {
    clearBpmTapResetTimer()
    params.bpmTapTimestamps.value = []
  }

  const schedulePreviewBpmTapReset = () => {
    clearBpmTapResetTimer()
    bpmTapResetTimer = setTimeout(() => {
      bpmTapResetTimer = null
      params.bpmTapTimestamps.value = []
    }, PREVIEW_BPM_TAP_RESET_MS)
  }

  const persistGridDefinition = async () => {
    clearPersistTimer()
    const filePath = String(params.song()?.filePath || '').trim()
    if (!filePath) return
    pendingLocalGridSignature = buildPreviewGridSignature()
    pendingLocalGridStartedAt = Date.now()
    const previewBeatGridMap = normalizeSongBeatGridMapV2(params.previewBeatGridMap?.value, {
      durationSec: params.resolvePreviewDurationSec?.(),
      allowSingleClip: true
    })
    const beatGridProjection = projectSongBeatGridMapV2ToFixedGrid(previewBeatGridMap)
    const firstBeatMs = Number(params.previewFirstBeatMs.value)
    const fallbackBpm = Number(params.previewBpm.value) || 0
    const fallbackFirstBeatMs = Number.isFinite(firstBeatMs) ? firstBeatMs : 0
    const fallbackDownbeatBeatOffset = normalizeBeatOffset(
      params.previewDownbeatBeatOffset.value,
      PREVIEW_DOWNBEAT_BEAT_INTERVAL
    )
    const beatGridMap =
      previewBeatGridMap ??
      createSongBeatGridMapV2FromFixedGrid({
        bpm: beatGridProjection?.bpm ?? fallbackBpm,
        firstBeatMs: beatGridProjection?.firstBeatMs ?? fallbackFirstBeatMs,
        downbeatBeatOffset: beatGridProjection?.downbeatBeatOffset ?? fallbackDownbeatBeatOffset,
        source: 'manual'
      })
    if (!beatGridMap) return
    const payload = { filePath, beatGridMap }
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-grid-definition', payload)
    } catch (error) {
      console.error('[horizontal-browse] persist grid definition failed', error)
    }
  }

  const schedulePersistGridDefinition = () => {
    clearPersistTimer()
    pendingLocalGridSignature = buildPreviewGridSignature()
    pendingLocalGridStartedAt = Date.now()
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistGridDefinition()
    }, 120)
  }

  const shouldDeferSongGridSync = (songGridSignature = buildSongGridSignature()) => {
    if (!pendingLocalGridSignature) return false
    if (songGridSignature !== pendingLocalGridSignature) {
      if (Date.now() - pendingLocalGridStartedAt <= PENDING_LOCAL_GRID_SYNC_HOLD_MS) {
        return true
      }
      pendingLocalGridSignature = ''
      pendingLocalGridStartedAt = 0
      return true
    }
    pendingLocalGridSignature = ''
    pendingLocalGridStartedAt = 0
    return false
  }

  return {
    buildPreviewGridSignature,
    buildSongGridSignature,
    clearPendingLocalGridSignature: () => {
      pendingLocalGridSignature = ''
      pendingLocalGridStartedAt = 0
    },
    clearPersistTimer,
    clearBpmTapResetTimer,
    resetPreviewBpmTap,
    schedulePreviewBpmTapReset,
    persistGridDefinition,
    schedulePersistGridDefinition,
    shouldDeferSongGridSync
  }
}
