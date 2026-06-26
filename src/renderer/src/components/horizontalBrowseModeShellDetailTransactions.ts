import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseDeckDetailLaneExpose } from '@renderer/components/horizontalBrowseModeShellTypes'
import {
  alignHorizontalBrowseLinkedGridVisualTransactionResults,
  type HorizontalBrowseLinkedGridVisualTransactionDeckState,
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

type LinkedGridVisualTransactionPayload = {
  leader: DeckKey
  follower: DeckKey
  deckStates?: Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>>
}

type LinkedGridVisualTransactionOptions = {
  begin?: boolean
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

  const resolveTransactionDecks = (payload?: LinkedGridVisualTransactionPayload) => {
    const leader = payload?.leader ?? 'top'
    const follower = payload?.follower ?? (leader === 'top' ? 'bottom' : 'top')
    return { leader, follower }
  }

  const beginLinkedGridVisualTransaction = (payload?: LinkedGridVisualTransactionPayload) => {
    const { leader, follower } = resolveTransactionDecks(payload)
    presentation.beginSyncTransaction(leader, follower)
  }

  const cancelLinkedGridVisualTransaction = (payload?: LinkedGridVisualTransactionPayload) => {
    const { leader, follower } = resolveTransactionDecks(payload)
    presentation.finishSyncTransaction(leader, follower, false, {})
  }

  const commitLinkedGridVisualTransaction = async (
    payload?: LinkedGridVisualTransactionPayload,
    options: LinkedGridVisualTransactionOptions = {}
  ) => {
    const { leader, follower } = resolveTransactionDecks(payload)
    if (options.begin !== false) {
      presentation.beginSyncTransaction(leader, follower)
    }
    let committed = false
    let results: HorizontalBrowseLinkedGridVisualTransactionResults = {}
    try {
      const deckStates = payload?.deckStates ?? {}
      const [topResult, bottomResult] = await Promise.all([
        Promise.resolve(
          resolveDetailRef('top')?.commitLinkedGridVisualTransaction?.(deckStates.top) ?? null
        ),
        Promise.resolve(
          resolveDetailRef('bottom')?.commitLinkedGridVisualTransaction?.(deckStates.bottom) ?? null
        )
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
    beginLinkedGridVisualTransaction,
    cancelLinkedGridVisualTransaction,
    commitLinkedGridVisualTransaction
  }
}
