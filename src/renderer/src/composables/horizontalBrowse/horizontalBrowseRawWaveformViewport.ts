import {
  clampHorizontalBrowsePreviewStartByVisibleDuration,
  resolveHorizontalBrowsePlaybackAlignedStart
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailMath'
import {
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellState'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import type {
  HorizontalBrowseWaveformLayout,
  UseHorizontalBrowseRawWaveformCanvasOptions
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasTypes'

export const createHorizontalBrowseRawWaveformViewport = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const resolvePreviewTimeScale = () =>
    Math.max(0.25, Number(options.visualPlaybackRate?.() ?? options.playbackRate()) || 1)

  const resolvePreviewDurationSec = () => {
    const duration = Number(
      options.rawData.value?.duration ||
        options.mixxxData.value?.duration ||
        parseHorizontalBrowseDurationToSeconds(options.song()?.duration) ||
        0
    )
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  const canShowTimelinePlaceholder = () => {
    if (!String(options.song()?.filePath || '').trim()) return false
    return resolvePreviewDurationSec() > 0
  }

  const resolveVisibleDurationSec = () =>
    Math.max(
      0.001,
      (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) /
        Number(options.previewZoom.value || HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
    )

  const resolvePreviewAnchorSec = () => {
    const duration = resolvePreviewDurationSec()
    const visibleDuration = resolveVisibleDurationSec()
    if (!duration || !visibleDuration) return 0
    const anchorSec =
      options.previewStartSec.value + visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    return options.allowNegativeTimeline()
      ? Math.min(Number.isFinite(anchorSec) ? anchorSec : 0, duration)
      : clampNumber(anchorSec, 0, duration)
  }

  const clampPreviewStart = (value: number) =>
    clampHorizontalBrowsePreviewStartByVisibleDuration(
      value,
      resolvePreviewDurationSec(),
      resolveVisibleDurationSec(),
      options.allowNegativeTimeline()
    )

  const resolveSnappedRenderStartSec = (visibleDuration: number) => {
    const clampedStart = clampPreviewStart(options.previewStartSec.value)
    if (visibleDuration <= 0) return clampedStart
    return clampedStart
  }

  const resolvePlaybackDrivenRenderStartSec = (visibleDuration: number) => {
    if (!options.playing.value || options.dragging.value) {
      return resolveSnappedRenderStartSec(visibleDuration)
    }
    return resolvePlaybackAlignedStart(Number(options.currentSeconds()) || 0)
  }

  const resolveWaveformLayout = (): HorizontalBrowseWaveformLayout => options.waveformLayout()

  const resolvePlaybackAlignedStart = (seconds: number) =>
    resolveHorizontalBrowsePlaybackAlignedStart(
      seconds,
      resolvePreviewDurationSec(),
      resolveVisibleDurationSec(),
      options.allowNegativeTimeline()
    )

  return {
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    canShowTimelinePlaceholder,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackDrivenRenderStartSec,
    resolveWaveformLayout,
    resolvePlaybackAlignedStart
  }
}
