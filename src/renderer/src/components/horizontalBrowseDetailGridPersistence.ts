import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BPM_TAP_RESET_MS,
  normalizeBeatOffset
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { buildHorizontalBrowseRawWaveformGridSignature } from '@renderer/components/horizontalBrowseRawWaveformGridSignature'

type HorizontalBrowseDetailGridPersistenceParams = {
  song: () => ISongInfo | null
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
  bpmTapTimestamps: Ref<number[]>
}

export const createHorizontalBrowseDetailGridPersistence = (
  params: HorizontalBrowseDetailGridPersistenceParams
) => {
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
  let pendingLocalGridSignature = ''

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
      timeBasisOffsetMs: params.previewTimeBasisOffsetMs.value
    })

  const buildSongGridSignature = () =>
    buildHorizontalBrowseRawWaveformGridSignature({
      bpm: params.song()?.bpm,
      firstBeatMs: params.song()?.firstBeatMs,
      barBeatOffset: params.song()?.barBeatOffset,
      timeBasisOffsetMs: params.song()?.timeBasisOffsetMs
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
    const firstBeatMs = Number(params.previewFirstBeatMs.value)
    const payload = {
      filePath,
      bpm: Number(params.previewBpm.value) || 0,
      firstBeatMs: Number.isFinite(firstBeatMs) ? firstBeatMs : 0,
      barBeatOffset: normalizeBeatOffset(
        params.previewBarBeatOffset.value,
        PREVIEW_BAR_BEAT_INTERVAL
      )
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
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistGridDefinition()
    }, 120)
  }

  const shouldDeferSongGridSync = (songGridSignature = buildSongGridSignature()) => {
    if (!pendingLocalGridSignature) return false
    if (songGridSignature !== pendingLocalGridSignature) {
      pendingLocalGridSignature = ''
      return true
    }
    pendingLocalGridSignature = ''
    return false
  }

  return {
    buildPreviewGridSignature,
    buildSongGridSignature,
    clearPendingLocalGridSignature: () => {
      pendingLocalGridSignature = ''
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
