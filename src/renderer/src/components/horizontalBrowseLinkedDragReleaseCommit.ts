import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type {
  HorizontalBrowseDeckStateCommitOptions,
  HorizontalBrowseDeckTransportStateOverride
} from '@renderer/components/useHorizontalBrowseTransportMutations'

type DeckKey = HorizontalBrowseDeckKey

export type CommitHorizontalBrowseDeckStatesToNative = (
  overrides?: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>>,
  options?: HorizontalBrowseDeckStateCommitOptions
) => Promise<unknown>

type LinkedDragReleaseCommitParams = {
  deck: DeckKey
  otherDeck: DeckKey
  targetSec: number
  otherTargetSec: number
  shouldResume: boolean
  prepareDeckPlayheadIfNeeded: (deck: DeckKey) => Promise<void>
  startDeckRenderPlaybackClock: (deck: DeckKey, seconds: number) => void
  commitDeckStatesToNative: CommitHorizontalBrowseDeckStatesToNative
  stopIfStale: (reason: string) => boolean
}

const resolveDeckTargetSec = (
  currentDeck: DeckKey,
  sourceDeck: DeckKey,
  sourceTargetSec: number,
  otherTargetSec: number
) => (currentDeck === sourceDeck ? sourceTargetSec : otherTargetSec)

export const commitHorizontalBrowseLinkedDragRelease = async ({
  deck,
  otherDeck,
  targetSec,
  otherTargetSec,
  shouldResume,
  prepareDeckPlayheadIfNeeded,
  startDeckRenderPlaybackClock,
  commitDeckStatesToNative,
  stopIfStale
}: LinkedDragReleaseCommitParams) => {
  const nowMs = performance.now()
  const baseOverrides: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>> = {
    top: {
      currentSec: resolveDeckTargetSec('top', deck, targetSec, otherTargetSec),
      lastObservedAtMs: nowMs,
      playing: false
    },
    bottom: {
      currentSec: resolveDeckTargetSec('bottom', deck, targetSec, otherTargetSec),
      lastObservedAtMs: nowMs,
      playing: false
    }
  }
  await commitDeckStatesToNative(baseOverrides, { allowPhaseAlignment: false })
  if (stopIfStale('after-batch-seek-token-mismatch')) return false
  if (!shouldResume) return true
  const playheadReadyPromise = Promise.all([
    prepareDeckPlayheadIfNeeded(deck),
    prepareDeckPlayheadIfNeeded(otherDeck)
  ])
    .then(() => true)
    .catch(() => false)
  if (stopIfStale('after-visual-frame-token-mismatch')) return false
  const playheadReady = await playheadReadyPromise
  if (stopIfStale('after-prepare-playhead-token-mismatch')) return false
  const resumeObservedAtMs = performance.now()
  const resumeOverrides: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>> = {
    top: { ...baseOverrides.top, lastObservedAtMs: resumeObservedAtMs, playing: true },
    bottom: { ...baseOverrides.bottom, lastObservedAtMs: resumeObservedAtMs, playing: true }
  }
  startDeckRenderPlaybackClock(deck, targetSec)
  startDeckRenderPlaybackClock(otherDeck, otherTargetSec)
  await commitDeckStatesToNative(resumeOverrides, { allowPhaseAlignment: false })
  void playheadReady
  return !stopIfStale('after-batch-commit-token-mismatch')
}
