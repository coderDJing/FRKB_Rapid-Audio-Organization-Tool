import type { HorizontalBrowseGridShiftOptions } from '@renderer/components/useHorizontalBrowseGridToolbar'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionResult
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'

export type HorizontalBrowseViewMode = 'dual' | 'edit'

export type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

export type DeckCuePanelMode = 'memory' | 'hot-cue'

export type HorizontalBrowseDeckDetailLaneExpose = {
  toggleBarLinePicking?: () => void
  setBarLineAtPlayhead?: () => void
  shiftGridLargeLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput?: (value: string) => void
  blurBpmInput?: () => void
  tapBpm?: () => void
  cycleMetronomeState?: () => void
  prepareStableFrameForAnchor?: (
    seconds: number,
    options?: { timeoutMs?: number }
  ) => Promise<boolean>
  commitLinkedGridVisualTransaction?: (
    deckState?: HorizontalBrowseLinkedGridVisualTransactionDeckState,
    options?: HorizontalBrowseLinkedGridVisualTransactionCommitOptions
  ) => HorizontalBrowseLinkedGridVisualTransactionResult | null
}

export const EDIT_MODE_BPM_INPUT_TITLE = '网格 BPM：修改分析结果和网格线，不改变播放速度'
export const DUAL_MODE_BPM_INPUT_TITLE = '目标 BPM：临时改变播放速度，不修改网格线'
export const EDIT_MODE_TAP_BPM_TITLE = 'Tap：按节拍连续点击，实时修改网格 BPM，不改变播放速度'

export const createDefaultSharedDetailZoomState = (value: number): SharedDetailZoomState => ({
  value,
  anchorRatio: 0.5,
  sourceDirection: null,
  revision: 0
})

export const createDefaultDeckToolbarState = () => ({
  disabled: true,
  bpmInputValue: '',
  bpmStep: 0.01,
  bpmMin: 1,
  bpmMax: 300,
  bpmInputTitle: '',
  bpmInputFirst: false,
  showTapButton: false,
  tapBpmTitle: '',
  barLinePicking: false,
  metronomeEnabled: false,
  metronomeVolumeLevel: 2 as 1 | 2 | 3,
  canToggleMetronome: false
})
