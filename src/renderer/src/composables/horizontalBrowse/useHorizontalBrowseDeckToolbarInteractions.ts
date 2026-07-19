import type { Ref } from 'vue'
import {
  formatPreviewBpm,
  parsePreviewBpmInput
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type {
  HorizontalBrowseGridShiftOptions,
  HorizontalBrowseGridToolbarState
} from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'

type HorizontalBrowseDeckToolbarState = HorizontalBrowseGridToolbarState

type HorizontalBrowseDetailExpose = {
  setDownbeatLineAtPlayhead?: () => void
  shiftGridLargeLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput?: (value: string) => void
  blurBpmInput?: () => void
  tapBpm?: () => void
  selectWholeAdjustment?: () => void
  splitAfterPlayhead?: () => void
  deleteBoundary?: () => void
  freezeDynamicGridSelectionForBpmInput?: () => void
  releaseDynamicGridSelectionForBpmInput?: () => void
  cycleMetronomeState?: () => void
}

type UseHorizontalBrowseDeckToolbarInteractionsParams = {
  topDeckToolbarState: Ref<HorizontalBrowseDeckToolbarState>
  bottomDeckToolbarState: Ref<HorizontalBrowseDeckToolbarState>
  deckTempoInputDirty: Record<HorizontalBrowseDeckKey, boolean>
  deckTempoCommitToken: Record<HorizontalBrowseDeckKey, number>
  touchDeckInteraction: (deck: HorizontalBrowseDeckKey) => void
  resolveDetailRef: (deck: HorizontalBrowseDeckKey) => HorizontalBrowseDetailExpose | null
  resolveDeckToolbarBpmInputValue: (deck: HorizontalBrowseDeckKey) => string
  shouldPreserveGridShiftPhase: (deck: HorizontalBrowseDeckKey) => boolean
  shouldCommitBpmInputAsGridEdit: (deck: HorizontalBrowseDeckKey) => boolean
  setDeckTargetBpm: (deck: HorizontalBrowseDeckKey, targetBpm: number) => Promise<unknown>
}

export const useHorizontalBrowseDeckToolbarInteractions = (
  params: UseHorizontalBrowseDeckToolbarInteractionsParams
) => {
  const resolveToolbarStateRef = (deck: HorizontalBrowseDeckKey) =>
    deck === 'top' ? params.topDeckToolbarState : params.bottomDeckToolbarState

  const resolveGridShiftOptions = (
    deck: HorizontalBrowseDeckKey
  ): HorizontalBrowseGridShiftOptions =>
    params.shouldPreserveGridShiftPhase(deck) ? { preservePlaybackPhase: true } : {}

  const handleToolbarStateChange = (
    deck: HorizontalBrowseDeckKey,
    value: HorizontalBrowseDeckToolbarState
  ) => {
    const toolbarStateRef = resolveToolbarStateRef(deck)
    const nextValue = params.deckTempoInputDirty[deck]
      ? {
          ...value,
          bpmInputValue: toolbarStateRef.value.bpmInputValue
        }
      : { ...value }
    toolbarStateRef.value = nextValue
  }

  const handleDeckSetDownbeatLineAtPlayhead = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.setDownbeatLineAtPlayhead?.()
  }

  const handleDeckGridShiftLargeLeft = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridLargeLeft?.(resolveGridShiftOptions(deck))
  }

  const handleDeckGridShiftSmallLeft = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridSmallLeft?.(resolveGridShiftOptions(deck))
  }

  const handleDeckGridShiftSmallRight = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridSmallRight?.(resolveGridShiftOptions(deck))
  }

  const handleDeckGridShiftLargeRight = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridLargeRight?.(resolveGridShiftOptions(deck))
  }

  const handleDeckMetronomeStateCycle = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.cycleMetronomeState?.()
  }

  const handleDeckBpmTap = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    if (!params.shouldCommitBpmInputAsGridEdit(deck)) return
    params.resolveDetailRef(deck)?.tapBpm?.()
  }

  const handleDeckBpmInputUpdate = (deck: HorizontalBrowseDeckKey, value: string) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.freezeDynamicGridSelectionForBpmInput?.()
    const toolbarStateRef = resolveToolbarStateRef(deck)
    params.deckTempoCommitToken[deck] += 1
    params.deckTempoInputDirty[deck] = true
    toolbarStateRef.value = { ...toolbarStateRef.value, bpmInputValue: value }
  }

  const handleDeckBpmInputBlur = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    const toolbarStateRef = resolveToolbarStateRef(deck)
    const nextToolbarState = toolbarStateRef.value
    const parsed = parsePreviewBpmInput(nextToolbarState.bpmInputValue)
    if (parsed === null) {
      params.deckTempoInputDirty[deck] = false
      params.deckTempoCommitToken[deck] += 1
      params.resolveDetailRef(deck)?.releaseDynamicGridSelectionForBpmInput?.()
      toolbarStateRef.value = {
        ...nextToolbarState,
        bpmInputValue: params.resolveDeckToolbarBpmInputValue(deck)
      }
      return
    }

    const token = params.deckTempoCommitToken[deck] + 1
    params.deckTempoCommitToken[deck] = token
    const formattedBpm = formatPreviewBpm(parsed)
    toolbarStateRef.value = {
      ...nextToolbarState,
      bpmInputValue: formattedBpm
    }

    if (params.shouldCommitBpmInputAsGridEdit(deck)) {
      const detail = params.resolveDetailRef(deck)
      if (detail?.updateBpmInput && detail?.blurBpmInput) {
        detail.updateBpmInput(formattedBpm)
        detail.blurBpmInput()
        detail.releaseDynamicGridSelectionForBpmInput?.()
        params.deckTempoInputDirty[deck] = false
        const latestToolbarState = resolveToolbarStateRef(deck).value
        resolveToolbarStateRef(deck).value = {
          ...latestToolbarState,
          bpmInputValue: formattedBpm
        }
        return
      }

      params.deckTempoInputDirty[deck] = false
      params.resolveDetailRef(deck)?.releaseDynamicGridSelectionForBpmInput?.()
      const latestToolbarState = resolveToolbarStateRef(deck).value
      resolveToolbarStateRef(deck).value = {
        ...latestToolbarState,
        bpmInputValue: params.resolveDeckToolbarBpmInputValue(deck)
      }
      return
    }

    // 双轨 BPM 输入只在失焦时提交，输入过程中只维护草稿值。
    void params.setDeckTargetBpm(deck, parsed).finally(() => {
      if (params.deckTempoCommitToken[deck] !== token) return
      params.deckTempoInputDirty[deck] = false
      params.resolveDetailRef(deck)?.releaseDynamicGridSelectionForBpmInput?.()
      const latestToolbarState = resolveToolbarStateRef(deck).value
      resolveToolbarStateRef(deck).value = {
        ...latestToolbarState,
        bpmInputValue: params.resolveDeckToolbarBpmInputValue(deck)
      }
    })
  }

  const handleDeckSplitAfterPlayhead = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.splitAfterPlayhead?.()
  }

  const handleDeckSelectWholeAdjustment = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.selectWholeAdjustment?.()
  }

  const handleDeckDeleteBoundary = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.deleteBoundary?.()
  }

  return {
    handleToolbarStateChange,
    handleDeckSetDownbeatLineAtPlayhead,
    handleDeckGridShiftLargeLeft,
    handleDeckGridShiftSmallLeft,
    handleDeckGridShiftSmallRight,
    handleDeckGridShiftLargeRight,
    handleDeckMetronomeStateCycle,
    handleDeckBpmTap,
    handleDeckBpmInputUpdate,
    handleDeckBpmInputBlur,
    handleDeckSelectWholeAdjustment,
    handleDeckSplitAfterPlayhead,
    handleDeckDeleteBoundary
  }
}
