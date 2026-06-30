import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import {
  isHorizontalBrowseRawDataCoveringRange,
  isHorizontalBrowseRawDataIntersectingRange,
  resolveHorizontalBrowsePlaybackDurationSec
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCoverage'
import { resolveHorizontalBrowseActiveMixxxSelection } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasData'

export type HorizontalBrowseStableRevisionRenderKind = 'anchor' | 'playback' | 'viewport'

export const resolveHorizontalBrowseStableRevisionRenderKind = (
  preferPreviewStart: boolean,
  viewportOnly: boolean
): HorizontalBrowseStableRevisionRenderKind => {
  if (viewportOnly) return 'viewport'
  return preferPreviewStart ? 'anchor' : 'playback'
}

export const canReplacePendingHorizontalBrowseStableRevisionRender = (
  pendingKind: HorizontalBrowseStableRevisionRenderKind,
  incomingKind: HorizontalBrowseStableRevisionRenderKind
) => pendingKind !== 'anchor' && incomingKind === 'anchor'

export const resolveHorizontalBrowseWaveformGain = (value: unknown) => {
  const numeric = Number(value ?? 1)
  if (!Number.isFinite(numeric)) return 1
  return clampNumber(numeric, 0, 16)
}

export const resolveHorizontalBrowseRawSlotForRender = (rawData: RawWaveformData | null) => {
  if (!rawData) return null
  return 'live'
}

export const clearHorizontalBrowseRawWaveformGridCanvas = (canvas: HTMLCanvasElement | null) => {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

export const resolveHorizontalBrowsePlaybackDurationSecForRender = (
  rawData: RawWaveformData | null,
  previewDurationSec: number,
  timeBasisOffsetSec: number
) => resolveHorizontalBrowsePlaybackDurationSec(rawData, previewDurationSec, timeBasisOffsetSec)

export const isHorizontalBrowseRawDataCoveringRenderRange = (
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  timeBasisOffsetSec: number
) =>
  isHorizontalBrowseRawDataCoveringRange(
    rawData,
    rangeStartSec,
    rangeDurationSec,
    timeBasisOffsetSec
  )

export const isHorizontalBrowseRawDataIntersectingRenderRange = (
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  timeBasisOffsetSec: number
) =>
  isHorizontalBrowseRawDataIntersectingRange(
    rawData,
    rangeStartSec,
    rangeDurationSec,
    timeBasisOffsetSec
  )

export const resolveHorizontalBrowseActiveMixxxSelectionForCanvas = (
  mixxxData: MixxxWaveformData | null
) => resolveHorizontalBrowseActiveMixxxSelection(mixxxData)
