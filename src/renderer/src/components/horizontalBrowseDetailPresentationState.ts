import { computed, ref, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { normalizePreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON } from '@renderer/components/horizontalBrowseRawWaveformDetailMath'
import { publishHorizontalBrowseLinkedGridVisualPhaseSample } from '@renderer/components/horizontalBrowseLinkedGridVisualPhase'

type HorizontalBrowseDetailDirection = 'up' | 'down'
type HorizontalBrowseDetailLayout = 'full' | 'top-half' | 'bottom-half'

type HorizontalBrowseDetailPresentationStateParams = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDetailDirection
  gridBpm: () => number | undefined
  playbackRate: () => number | undefined
  visualPlaybackRate: () => number | undefined
  linkedGridActive: () => boolean
  linkedGridVisualPending: () => boolean
  waveformLayout: () => HorizontalBrowseDetailLayout
  waveformPlaybackActive: () => boolean
  resolveWaveformCurrentSeconds: () => number
  resolveWaveformPlaybackRate: () => number
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
}

export const createHorizontalBrowseDetailPresentationState = (
  params: HorizontalBrowseDetailPresentationStateParams
) => {
  const visualGridBpm = ref(0)
  const visualGridFirstBeatMs = ref(0)
  const visualGridBarBeatOffset = ref(0)
  const visualGridTimeBasisOffsetMs = ref(0)
  let lastAppliedPreviewTimeScale = 1

  const resolveDisplayGridBpm = () => {
    const songBpm = Number(params.song()?.bpm)
    return Number.isFinite(songBpm) && songBpm > 0 ? normalizePreviewBpm(songBpm) : 0
  }

  const previewRenderBpm = computed(() => {
    const localBpm = Number(params.previewBpm.value)
    if (
      Number.isFinite(localBpm) &&
      localBpm > 0 &&
      Math.abs(localBpm - resolveDisplayGridBpm()) > HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON
    ) {
      return normalizePreviewBpm(localBpm)
    }
    const gridBpm = Number(params.gridBpm())
    if (Number.isFinite(gridBpm) && gridBpm > 0) {
      return normalizePreviewBpm(gridBpm)
    }
    return localBpm || 0
  })

  const visualGridRenderBpm = computed(() => Number(visualGridBpm.value) || 0)

  const syncVisualGridStateFromPreview = () => {
    visualGridBpm.value = previewRenderBpm.value
    visualGridFirstBeatMs.value = params.previewFirstBeatMs.value
    visualGridBarBeatOffset.value = params.previewBarBeatOffset.value
    visualGridTimeBasisOffsetMs.value = params.previewTimeBasisOffsetMs.value
  }

  const resolveIncomingPreviewTimeScale = () =>
    Math.max(0.25, Number(params.visualPlaybackRate() ?? params.playbackRate()) || 1)

  const resolveCanvasVisualPlaybackRate = () =>
    params.linkedGridVisualPending()
      ? Math.max(0.25, Number(lastAppliedPreviewTimeScale) || 1)
      : resolveIncomingPreviewTimeScale()

  const publishLinkedGridVisualPhaseSample = () => {
    if (params.waveformLayout() === 'full') return
    if (!params.linkedGridActive()) return
    if (!params.song()?.filePath) return
    publishHorizontalBrowseLinkedGridVisualPhaseSample({
      direction: params.direction(),
      active: true,
      clockActive: params.waveformPlaybackActive(),
      bpm: visualGridRenderBpm.value,
      firstBeatMs: visualGridFirstBeatMs.value,
      barBeatOffset: visualGridBarBeatOffset.value,
      currentSec: params.resolveWaveformCurrentSeconds(),
      playbackRate: params.resolveWaveformPlaybackRate()
    })
  }

  return {
    previewRenderBpm,
    visualGridBpm,
    visualGridFirstBeatMs,
    visualGridBarBeatOffset,
    visualGridTimeBasisOffsetMs,
    visualGridRenderBpm,
    resolveDisplayGridBpm,
    resolveIncomingPreviewTimeScale,
    resolveCanvasVisualPlaybackRate,
    syncVisualGridStateFromPreview,
    publishLinkedGridVisualPhaseSample,
    getLastAppliedPreviewTimeScale: () => lastAppliedPreviewTimeScale,
    setLastAppliedPreviewTimeScale: (value: number) => {
      lastAppliedPreviewTimeScale = Math.max(0.25, Number(value) || 1)
    }
  }
}
