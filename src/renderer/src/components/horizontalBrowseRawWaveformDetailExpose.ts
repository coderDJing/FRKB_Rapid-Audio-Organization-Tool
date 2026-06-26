import type { HorizontalBrowseGridShiftOptions } from '@renderer/components/useHorizontalBrowseGridToolbar'
import type { HorizontalBrowseRawWaveformDetailExpose } from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionResult
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'

const HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX = 1
const HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX = 2.5

type CreateHorizontalBrowseRawWaveformDetailExposeParams = {
  toggleBarLinePicking: () => void
  setBarLineAtPlayhead: () => void
  shiftGrid: (deltaMs: number, options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput: (value: string) => void
  blurBpmInput: () => void
  tapBpm: () => void
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

const resolveGridShiftMs = (
  params: Pick<
    CreateHorizontalBrowseRawWaveformDetailExposeParams,
    'resolveVisibleDurationSec' | 'resolveWrapWidth'
  >,
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
      const deltaMs = resolveGridShiftMs(params, targetCssPx) * direction
      params.shiftGrid(deltaMs, options)
    }

  return {
    toggleBarLinePicking: params.toggleBarLinePicking,
    setBarLineAtPlayhead: params.setBarLineAtPlayhead,
    shiftGridSmallLeft: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX, -1),
    shiftGridLargeLeft: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX, -1),
    shiftGridSmallRight: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX, 1),
    shiftGridLargeRight: shiftBy(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX, 1),
    updateBpmInput: params.updateBpmInput,
    blurBpmInput: params.blurBpmInput,
    tapBpm: params.tapBpm,
    cycleMetronomeState: params.cycleMetronomeState,
    prepareStableFrameForAnchor: params.prepareStableFrameForAnchor,
    commitLinkedGridVisualTransaction: params.commitLinkedGridVisualTransaction
  }
}
