import type { Ref } from 'vue'
import type { HorizontalBrowseStableCanvasPresentationMeasureResult } from './horizontalBrowseStableCanvasPresentation'

type StableInteractionHandoffOptions = {
  previewStartSec: Ref<number>
  compactVisualWaveformActive: Ref<boolean>
  normalizeSeconds: (seconds: number) => number
  clampPreviewStart: (seconds: number) => number
  resolvePlaybackAlignedStart: (seconds: number) => number
  resolveVisibleDurationSec: () => number
  resolveRenderedCanvasViewportStartSec: () => number | null
  suppressStablePlaybackReanchor: () => void
  stopStableCanvasPlayback: () => void
  hideStableCanvasPresentation: () => void
  drawWaveformNow: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  scheduleDraw: () => void
  playheadRatio: number
}

const STABLE_PLAYBACK_TOGGLE_RENDER_HOLD_MS = 450
const STABLE_SEEK_SYNC_HANDOFF_MS = 450

export const createHorizontalBrowseStableInteractionHandoff = (
  options: StableInteractionHandoffOptions
) => {
  let playbackToggleRenderHoldUntilMs = 0
  let seekSyncHandoffRevision = 0
  let seekSyncHandoffTargetSec = 0
  let seekSyncHandoffUntilMs = 0
  let seekRenderFirstRaf = 0
  let seekRenderSecondRaf = 0
  let seekRenderSequence = 0

  const applyPreviewPlaybackPosition = (
    seconds: number,
    scheduleFrame = true,
    immediateFrame = false,
    viewportOnly = true
  ) => {
    const safeSeconds = options.normalizeSeconds(seconds)
    const nextStartSec = options.resolvePlaybackAlignedStart(safeSeconds)
    if (Math.abs(nextStartSec - options.previewStartSec.value) > 0.0001) {
      options.previewStartSec.value = nextStartSec
    }
    if (scheduleFrame) {
      if (immediateFrame) {
        options.drawWaveformNow({ preferPreviewStart: true, viewportOnly })
      } else {
        options.scheduleDraw()
      }
    }
  }

  const shouldRenderStableCanvasForPlaybackToggle = (
    measured: HorizontalBrowseStableCanvasPresentationMeasureResult
  ) => !measured.presentable

  const freezeStableCanvasPlaybackTogglePosition = (anchorSec: number) => {
    const renderedViewportStartSec = options.resolveRenderedCanvasViewportStartSec()
    const nextStartSec =
      renderedViewportStartSec !== null && Number.isFinite(renderedViewportStartSec)
        ? options.clampPreviewStart(renderedViewportStartSec)
        : options.resolvePlaybackAlignedStart(anchorSec)
    if (Math.abs(nextStartSec - options.previewStartSec.value) > 0.0001) {
      options.previewStartSec.value = nextStartSec
    }
    return options.normalizeSeconds(
      nextStartSec + options.resolveVisibleDurationSec() * options.playheadRatio
    )
  }

  const holdStablePlaybackToggleRender = () => {
    playbackToggleRenderHoldUntilMs = performance.now() + STABLE_PLAYBACK_TOGGLE_RENDER_HOLD_MS
  }

  const isStablePlaybackToggleRenderHeld = () => {
    if (playbackToggleRenderHoldUntilMs <= 0) return false
    if (performance.now() <= playbackToggleRenderHoldUntilMs) return true
    playbackToggleRenderHoldUntilMs = 0
    return false
  }

  const startStableSeekSyncHandoff = (revision: number, targetSeconds: number) => {
    seekSyncHandoffRevision = Math.max(0, Math.floor(Number(revision) || 0))
    seekSyncHandoffTargetSec = options.normalizeSeconds(targetSeconds)
    seekSyncHandoffUntilMs = performance.now() + STABLE_SEEK_SYNC_HANDOFF_MS
  }

  const isStableSeekSyncHandoffActive = (revision: number, seconds: number) => {
    if (seekSyncHandoffRevision <= 0) return false
    if (seekSyncHandoffRevision !== Math.max(0, Math.floor(Number(revision) || 0))) {
      return false
    }
    if (performance.now() > seekSyncHandoffUntilMs) {
      seekSyncHandoffRevision = 0
      seekSyncHandoffUntilMs = 0
      return false
    }
    return Math.abs(options.normalizeSeconds(seconds) - seekSyncHandoffTargetSec) <= 2
  }

  const clearStableSeekRenderRaf = () => {
    if (seekRenderFirstRaf) {
      cancelAnimationFrame(seekRenderFirstRaf)
      seekRenderFirstRaf = 0
    }
    if (seekRenderSecondRaf) {
      cancelAnimationFrame(seekRenderSecondRaf)
      seekRenderSecondRaf = 0
    }
  }

  const scheduleStableSeekRenderAfterHidePaint = (seconds: number) => {
    const safeSeconds = options.normalizeSeconds(seconds)
    const sequence = ++seekRenderSequence
    clearStableSeekRenderRaf()
    seekRenderFirstRaf = requestAnimationFrame(() => {
      seekRenderFirstRaf = 0
      seekRenderSecondRaf = requestAnimationFrame(() => {
        seekRenderSecondRaf = 0
        if (sequence !== seekRenderSequence) return
        options.drawWaveformNow({ preferPreviewStart: true, viewportOnly: true })
      })
    })
    applyPreviewPlaybackPosition(safeSeconds, false)
  }

  const forceRenderStableSeekTarget = (seconds: number) => {
    const safeSeconds = options.normalizeSeconds(seconds)
    if (options.compactVisualWaveformActive.value) {
      options.suppressStablePlaybackReanchor()
      options.stopStableCanvasPlayback()
      options.hideStableCanvasPresentation()
    }
    scheduleStableSeekRenderAfterHidePaint(safeSeconds)
  }

  return {
    applyPreviewPlaybackPosition,
    shouldRenderStableCanvasForPlaybackToggle,
    freezeStableCanvasPlaybackTogglePosition,
    holdStablePlaybackToggleRender,
    isStablePlaybackToggleRenderHeld,
    startStableSeekSyncHandoff,
    isStableSeekSyncHandoffActive,
    forceRenderStableSeekTarget,
    clearStableSeekRenderRaf
  }
}
