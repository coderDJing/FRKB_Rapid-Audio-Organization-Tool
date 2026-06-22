import type { Ref } from 'vue'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/components/horizontalBrowseWaveform.constants'

const STABLE_FRAME_PREPARE_TIMEOUT_MS = 700
const STABLE_FRAME_PREPARE_ANCHOR_EPSILON_SEC = 0.08
const PLAYBACK_STABLE_FRAME_RENDER_DEBOUNCE_MS = 180

type HorizontalBrowseDetailPresentationActionsParams = {
  currentSeconds: () => number | undefined
  compactVisualWaveformActive: Ref<boolean>
  previewStartSec: Ref<number>
  localGridShiftPhaseOffsetSec: Ref<number>
  waveformPlaybackActive: () => boolean
  normalizePreviewTimelineSeconds: (seconds: number) => number
  resolveVisibleDurationSec: () => number
  resolveWaveformCurrentSeconds: () => number
  clampPreviewStart: (seconds: number) => number
  stopStableCanvasPlayback: () => void
  drawWaveformNow: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  measureStableCanvasPresentation: (seconds?: number) => { frame: { anchorSec: number } | null }
  getLastAppliedPreviewTimeScale: () => number
  setLastAppliedPreviewTimeScale: (value: number) => void
  resolveIncomingPreviewTimeScale: () => number
  invalidateWaveformTiles: (options?: { preserveDisplay?: boolean }) => void
  resetGridRenderer: () => void
  maybeContinueWaveformSource: (anchorSec?: number) => void
  scheduleDraw: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  syncGridStateFromSong: () => void
  syncVisualGridStateFromPreview: () => void
  applyPreviewPlaybackPosition: (seconds: number, resetDiscontinuity?: boolean) => void
  publishLinkedGridVisualPhaseSample: () => void
  markLinkedGridVisualTransactionCommitted: () => void
}

export const createHorizontalBrowseDetailPresentationActions = (
  params: HorizontalBrowseDetailPresentationActionsParams
) => {
  let playbackStableFrameRenderTimer: ReturnType<typeof setTimeout> | null = null

  const clearPlaybackStableFrameRenderTimer = () => {
    if (!playbackStableFrameRenderTimer) return
    clearTimeout(playbackStableFrameRenderTimer)
    playbackStableFrameRenderTimer = null
  }

  const schedulePlaybackStableFrameRender = () => {
    clearPlaybackStableFrameRenderTimer()
    playbackStableFrameRenderTimer = setTimeout(() => {
      playbackStableFrameRenderTimer = null
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }, PLAYBACK_STABLE_FRAME_RENDER_DEBOUNCE_MS)
  }

  const waitForStableFrameAnchor = async (
    seconds: number,
    timeoutMs = STABLE_FRAME_PREPARE_TIMEOUT_MS
  ) => {
    if (!params.compactVisualWaveformActive.value) return true
    const safeSeconds = params.normalizePreviewTimelineSeconds(seconds)
    const startedAt = performance.now()
    const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0)
    while (performance.now() - startedAt < safeTimeoutMs) {
      const frame = params.measureStableCanvasPresentation(safeSeconds).frame
      if (
        frame &&
        Math.abs(Number(frame.anchorSec) - safeSeconds) <= STABLE_FRAME_PREPARE_ANCHOR_EPSILON_SEC
      ) {
        return true
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return false
  }

  const prepareStableFrameForAnchor = async (
    seconds: number,
    options: { timeoutMs?: number } = {}
  ) => {
    if (!params.compactVisualWaveformActive.value) return true
    const safeSeconds = params.normalizePreviewTimelineSeconds(seconds)
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? STABLE_FRAME_PREPARE_TIMEOUT_MS) || 0)
    params.previewStartSec.value = params.clampPreviewStart(
      safeSeconds - params.resolveVisibleDurationSec() * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    params.stopStableCanvasPlayback()
    params.drawWaveformNow({ preferPreviewStart: true })
    return waitForStableFrameAnchor(safeSeconds, timeoutMs)
  }

  const applyIncomingPreviewTimeScale = (scheduleFrame = true) => {
    const safeNextScale = Math.max(0.25, Number(params.resolveIncomingPreviewTimeScale()) || 1)
    const safePreviousScale = Math.max(
      0.25,
      Number(params.getLastAppliedPreviewTimeScale()) || safeNextScale
    )
    const nextVisible = params.resolveVisibleDurationSec()
    const previousVisible = Math.max(0.001, nextVisible * (safePreviousScale / safeNextScale))
    if (
      Math.abs(safeNextScale - safePreviousScale) <= 0.000001 &&
      Math.abs(nextVisible - previousVisible) <= 0.0001
    ) {
      return false
    }
    params.setLastAppliedPreviewTimeScale(safeNextScale)
    const playbackTimeScaleActive = params.waveformPlaybackActive()
    const anchorSec = playbackTimeScaleActive
      ? params.resolveWaveformCurrentSeconds()
      : params.previewStartSec.value + previousVisible * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    params.previewStartSec.value = params.clampPreviewStart(
      anchorSec - nextVisible * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    params.invalidateWaveformTiles({ preserveDisplay: params.compactVisualWaveformActive.value })
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(anchorSec)
    if (scheduleFrame) {
      if (playbackTimeScaleActive) {
        schedulePlaybackStableFrameRender()
      } else {
        clearPlaybackStableFrameRenderTimer()
        params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
      }
    }
    return true
  }

  const commitLinkedGridVisualTransaction = () => {
    const targetSeconds = Number(params.currentSeconds()) || 0
    clearPlaybackStableFrameRenderTimer()
    params.localGridShiftPhaseOffsetSec.value = 0
    params.syncGridStateFromSong()
    params.syncVisualGridStateFromPreview()
    const safeSeconds = params.normalizePreviewTimelineSeconds(targetSeconds)
    applyIncomingPreviewTimeScale(false)
    params.applyPreviewPlaybackPosition(safeSeconds, false)
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(safeSeconds)
    if (params.waveformPlaybackActive()) {
      schedulePlaybackStableFrameRender()
    } else {
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }
    params.publishLinkedGridVisualPhaseSample()
    params.markLinkedGridVisualTransactionCommitted()
    return true
  }

  return {
    clearPlaybackStableFrameRenderTimer,
    schedulePlaybackStableFrameRender,
    prepareStableFrameForAnchor,
    applyIncomingPreviewTimeScale,
    commitLinkedGridVisualTransaction
  }
}
