import type { Ref } from 'vue'
import {
  formatPreviewBpm,
  parsePreviewBpmInput
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseGridToolbarState } from '@renderer/components/useHorizontalBrowseGridToolbar'

type HorizontalBrowseDeckToolbarState = HorizontalBrowseGridToolbarState

type HorizontalBrowseDetailExpose = {
  toggleBarLinePicking?: () => void
  setBarLineAtPlayhead?: () => void
  shiftGridLargeLeft?: () => void
  shiftGridSmallLeft?: () => void
  shiftGridSmallRight?: () => void
  shiftGridLargeRight?: () => void
}

type UseHorizontalBrowseDeckToolbarInteractionsParams = {
  topDeckToolbarState: Ref<HorizontalBrowseDeckToolbarState>
  bottomDeckToolbarState: Ref<HorizontalBrowseDeckToolbarState>
  deckTempoInputDirty: Record<HorizontalBrowseDeckKey, boolean>
  deckTempoCommitToken: Record<HorizontalBrowseDeckKey, number>
  touchDeckInteraction: (deck: HorizontalBrowseDeckKey) => void
  resolveDetailRef: (deck: HorizontalBrowseDeckKey) => HorizontalBrowseDetailExpose | null
  resolveDeckToolbarBpmInputValue: (deck: HorizontalBrowseDeckKey) => string
  setDeckTargetBpm: (deck: HorizontalBrowseDeckKey, targetBpm: number) => Promise<unknown>
}

export const useHorizontalBrowseDeckToolbarInteractions = (
  params: UseHorizontalBrowseDeckToolbarInteractionsParams
) => {
  const resolveToolbarStateRef = (deck: HorizontalBrowseDeckKey) =>
    deck === 'top' ? params.topDeckToolbarState : params.bottomDeckToolbarState

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

  const handleDeckBarLinePickingToggle = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.toggleBarLinePicking?.()
  }

  const handleDeckSetBarLineAtPlayhead = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.setBarLineAtPlayhead?.()
  }

  const handleDeckGridShiftLargeLeft = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridLargeLeft?.()
  }

  const handleDeckGridShiftSmallLeft = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridSmallLeft?.()
  }

  const handleDeckGridShiftSmallRight = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridSmallRight?.()
  }

  const handleDeckGridShiftLargeRight = (deck: HorizontalBrowseDeckKey) => {
    params.touchDeckInteraction(deck)
    params.resolveDetailRef(deck)?.shiftGridLargeRight?.()
  }

  const handleDeckBpmInputUpdate = (deck: HorizontalBrowseDeckKey, value: string) => {
    params.touchDeckInteraction(deck)
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
      toolbarStateRef.value = {
        ...nextToolbarState,
        bpmInputValue: params.resolveDeckToolbarBpmInputValue(deck)
      }
      return
    }

    const token = params.deckTempoCommitToken[deck] + 1
    params.deckTempoCommitToken[deck] = token
    toolbarStateRef.value = {
      ...nextToolbarState,
      bpmInputValue: formatPreviewBpm(parsed)
    }

    // 横推 BPM 输入只在失焦时提交，输入过程中只维护草稿值。
    void params.setDeckTargetBpm(deck, parsed).finally(() => {
      if (params.deckTempoCommitToken[deck] !== token) return
      params.deckTempoInputDirty[deck] = false
      const latestToolbarState = resolveToolbarStateRef(deck).value
      resolveToolbarStateRef(deck).value = {
        ...latestToolbarState,
        bpmInputValue: params.resolveDeckToolbarBpmInputValue(deck)
      }
    })
  }

  return {
    handleToolbarStateChange,
    handleDeckBarLinePickingToggle,
    handleDeckSetBarLineAtPlayhead,
    handleDeckGridShiftLargeLeft,
    handleDeckGridShiftSmallLeft,
    handleDeckGridShiftSmallRight,
    handleDeckGridShiftLargeRight,
    handleDeckBpmInputUpdate,
    handleDeckBpmInputBlur
  }
}
