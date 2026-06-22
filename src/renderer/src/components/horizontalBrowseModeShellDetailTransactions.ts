import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseDeckDetailLaneExpose } from '@renderer/components/horizontalBrowseModeShellTypes'
import {
  alignHorizontalBrowseLinkedGridVisualTransactionResults,
  type HorizontalBrowseLinkedGridVisualTransactionResults
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'

type DeckKey = HorizontalBrowseDeckKey

type WaveformPresentationTransactionState = {
  beginSyncTransaction: (leader: DeckKey, follower: DeckKey) => void
  finishSyncTransaction: (
    leader: DeckKey,
    follower: DeckKey,
    committed: boolean,
    results: HorizontalBrowseLinkedGridVisualTransactionResults
  ) => void
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
    let results: HorizontalBrowseLinkedGridVisualTransactionResults = {}
    try {
      const [topResult, bottomResult] = await Promise.all([
        Promise.resolve(resolveDetailRef('top')?.commitLinkedGridVisualTransaction?.() ?? null),
        Promise.resolve(resolveDetailRef('bottom')?.commitLinkedGridVisualTransaction?.() ?? null)
      ])
      results.top = topResult
      results.bottom = bottomResult
      committed = topResult?.committed === true && bottomResult?.committed === true
      if (committed) {
        results = alignHorizontalBrowseLinkedGridVisualTransactionResults(results, leader, follower)
      }
      return committed
    } finally {
      presentation.finishSyncTransaction(leader, follower, committed, results)
    }
  }

  return {
    prepareDeckStableFrameForAnchor,
    commitLinkedGridVisualTransaction
  }
}
