import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseDeckDetailLaneExpose } from '@renderer/components/horizontalBrowseModeShellTypes'

type DeckKey = HorizontalBrowseDeckKey

type WaveformPresentationTransactionState = {
  beginSyncTransaction: (leader: DeckKey, follower: DeckKey) => void
  finishSyncTransaction: (leader: DeckKey, follower: DeckKey, committed: boolean) => void
}

type ShellDetailTransactionsParams = {
  presentation: WaveformPresentationTransactionState
  resolveDetailRef: (deck: DeckKey) => HorizontalBrowseDeckDetailLaneExpose | null
}

export const createHorizontalBrowseModeShellDetailTransactions = ({
  presentation,
  resolveDetailRef
}: ShellDetailTransactionsParams) => {
  const prepareDeckStableFrameForAnchor = (
    deck: DeckKey,
    seconds: number,
    options?: { timeoutMs?: number }
  ) =>
    resolveDetailRef(deck)?.prepareStableFrameForAnchor?.(seconds, options) ??
    Promise.resolve(false)

  const commitLinkedGridVisualTransaction = async (payload?: {
    leader: DeckKey
    follower: DeckKey
  }) => {
    const leader = payload?.leader ?? 'top'
    const follower = payload?.follower ?? (leader === 'top' ? 'bottom' : 'top')
    presentation.beginSyncTransaction(leader, follower)
    let committed = false
    try {
      const [topCommitted, bottomCommitted] = await Promise.all([
        Promise.resolve(resolveDetailRef('top')?.commitLinkedGridVisualTransaction?.() ?? false),
        Promise.resolve(resolveDetailRef('bottom')?.commitLinkedGridVisualTransaction?.() ?? false)
      ])
      committed = topCommitted && bottomCommitted
      return committed
    } finally {
      presentation.finishSyncTransaction(leader, follower, committed)
    }
  }

  return {
    prepareDeckStableFrameForAnchor,
    commitLinkedGridVisualTransaction
  }
}
