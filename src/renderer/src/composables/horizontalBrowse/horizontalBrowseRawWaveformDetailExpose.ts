import type { HorizontalBrowseGridShiftOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import type { HorizontalBrowseRawWaveformDetailExpose } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionResult
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'

export const HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX = 1
export const HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX = 2.5

type CreateHorizontalBrowseRawWaveformDetailExposeParams = {
  setDownbeatLineAtPlayhead: () => void
  shiftGrid: (deltaMs: number, options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput: (value: string) => void
  blurBpmInput: () => void
  tapBpm: () => void
  selectWholeAdjustment: () => void
  splitAfterPlayhead: () => void
  deleteBoundary: () => void
  freezeDynamicGridSelectionForBpmInput: () => void
  releaseDynamicGridSelectionForBpmInput: () => void
  cycleMetronomeState: () => void
  prepareStableFrameForAnchor: (
    seconds: number,
    options?: { timeoutMs?: number }
  ) => Promise<boolean>
  commitLinkedGridVisualTransaction: (
    deckState?: HorizontalBrowseLinkedGridVisualTransactionDeckState,
    options?: HorizontalBrowseLinkedGridVisualTransactionCommitOptions
  ) => HorizontalBrowseLinkedGridVisualTransactionResult | null
  resolveVisibleDurationSec: () => number
  resolveWrapWidth: () => number
}

export type HorizontalBrowseGridShiftMsParams = {
  resolveVisibleDurationSec: () => number
  resolveWrapWidth: () => number
}

export const resolveHorizontalBrowseGridShiftMs = (
  params: HorizontalBrowseGridShiftMsParams,
  targetCssPx: number
) => {
  const visibleDurationMs = Math.max(1, params.resolveVisibleDurationSec() * 1000)
  const wrapWidth = Math.max(1, Number(params.resolveWrapWidth()) || 0)
  const msPerPixel = visibleDurationMs / wrapWidth
  return msPerPixel * targetCssPx
}

export const createHorizontalBrowseRawWaveformDetailExpose = (
  params: CreateHorizontalBrowseRawWaveformDetailExposeParams
): HorizontalBrowseRawWaveformDetailExpose => {
  const shiftBy =
    (targetCssPx: number, direction: 1 | -1) => (options?: HorizontalBrowseGridShiftOptions) => {
      const deltaMs = resolveHorizontalBrowseGridShiftMs(params, targetCssPx) * direction
      params.shiftGrid(deltaMs, options)
    }

  return {
    setDownbeatLineAtPlayhead: params.setDownbeatLineAtPlayhead,
    shiftGridSmallLeft: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX, -1),
    shiftGridLargeLeft: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX, -1),
    shiftGridSmallRight: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX, 1),
    shiftGridLargeRight: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX, 1),
    updateBpmInput: params.updateBpmInput,
    blurBpmInput: params.blurBpmInput,
    tapBpm: params.tapBpm,
    selectWholeAdjustment: params.selectWholeAdjustment,
    splitAfterPlayhead: params.splitAfterPlayhead,
    deleteBoundary: params.deleteBoundary,
    freezeDynamicGridSelectionForBpmInput: params.freezeDynamicGridSelectionForBpmInput,
    releaseDynamicGridSelectionForBpmInput: params.releaseDynamicGridSelectionForBpmInput,
    cycleMetronomeState: params.cycleMetronomeState,
    prepareStableFrameForAnchor: params.prepareStableFrameForAnchor,
    commitLinkedGridVisualTransaction: params.commitLinkedGridVisualTransaction
  }
}
