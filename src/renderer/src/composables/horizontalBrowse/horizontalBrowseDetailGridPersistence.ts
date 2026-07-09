import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { SongBeatGridMap } from '@shared/songBeatGridMap'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BPM_TAP_RESET_MS,
  normalizeBeatOffset
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { buildHorizontalBrowseRawWaveformGridSignature } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformGridSignature'
import {
  normalizeSongBeatGridMap,
  projectSongBeatGridMapToFixedGrid
} from '@shared/songBeatGridMap'

type HorizontalBrowseDetailGridPersistenceParams = {
  song: () => ISongInfo | null
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
  previewBeatGridMap?: Ref<SongBeatGridMap | null>
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
      barBeatOffset: params.previewBarBeatOffset.value,
      timeBasisOffsetMs: params.previewTimeBasisOffsetMs.value,
      beatGridMapSignature: params.previewBeatGridMap?.value?.signature
    })

  const buildSongGridSignature = () =>
    buildHorizontalBrowseRawWaveformGridSignature({
      bpm: params.song()?.bpm,
      firstBeatMs: params.song()?.firstBeatMs,
      barBeatOffset: params.song()?.barBeatOffset,
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
    const previewBeatGridMap = normalizeSongBeatGridMap(params.previewBeatGridMap?.value, {
      durationSec: params.resolvePreviewDurationSec?.()
    })
    const beatGridProjection = projectSongBeatGridMapToFixedGrid(previewBeatGridMap)
    const firstBeatMs = Number(params.previewFirstBeatMs.value)
    const fallbackBpm = Number(params.previewBpm.value) || 0
    const fallbackFirstBeatMs = Number.isFinite(firstBeatMs) ? firstBeatMs : 0
    const fallbackBarBeatOffset = normalizeBeatOffset(
      params.previewBarBeatOffset.value,
      PREVIEW_BAR_BEAT_INTERVAL
    )
    const payload = {
      filePath,
      bpm: beatGridProjection?.bpm ?? fallbackBpm,
      firstBeatMs: beatGridProjection?.firstBeatMs ?? fallbackFirstBeatMs,
      barBeatOffset: beatGridProjection?.barBeatOffset ?? fallbackBarBeatOffset,
      beatGridMap: previewBeatGridMap
    }
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
