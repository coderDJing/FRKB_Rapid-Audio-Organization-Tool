import type { Ref } from 'vue'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/components/horizontalBrowseWaveform.constants'
import { normalizeHorizontalBrowseSharedZoom } from '@renderer/components/horizontalBrowseRawWaveformDetailMath'
import type { HorizontalBrowseSharedZoomState } from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseWaveformPresentationState } from '@renderer/components/horizontalBrowseWaveformPresentationCoordinator'

type DeckKey = HorizontalBrowseDeckKey

type DetailPresentationConsumerParams = {
  deck: () => DeckKey
  direction: () => 'up' | 'down'
  presentationState: () => HorizontalBrowseWaveformPresentationState | undefined
  previewZoom: Ref<number>
  previewMaxZoom: Ref<number>
  previewStartSec: Ref<number>
  waveformPlaybackActive: () => boolean
  resolveWaveformCurrentSeconds: () => number
  resolveVisibleDurationSec: () => number
  clampPreviewStart: (seconds: number) => number
  resetGridRenderer: () => void
  maybeContinueWaveformSource: (anchorSec?: number) => void
  schedulePlaybackStableFrameRender: () => void
  clearPlaybackStableFrameRenderTimer: () => void
  scheduleDraw: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  applyPresentationSeekTarget: (seconds: number, revision: number) => void
}

type ZoomTarget = {
  value: number | null | undefined
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  anchorSec?: number | null
  viewportStartSec?: number | null
}

const isFiniteNumber = (value: unknown): value is number =>
  value !== null && value !== undefined && Number.isFinite(Number(value))

const isZoomOwner = (state: HorizontalBrowseWaveformPresentationState | undefined) =>
  state?.owner === 'zoom' || state?.owner === 'linked-zoom'

const resolveDeckDirection = (deck: DeckKey | null): 'up' | 'down' | null =>
  deck === 'top' ? 'up' : deck === 'bottom' ? 'down' : null

export const createHorizontalBrowseDetailPresentationConsumer = (
  params: DetailPresentationConsumerParams
) => {
  let consumedPresentationRevision = 0

  const applyZoomTarget = (target: ZoomTarget) => {
    const numeric = Number(target.value)
    if (!Number.isFinite(numeric) || numeric <= 0) return
    const nextZoom = normalizeHorizontalBrowseSharedZoom(
      {
        value: numeric,
        anchorRatio: target.anchorRatio,
        sourceDirection: target.sourceDirection,
        revision: 0
      },
      params.previewMaxZoom.value
    )
    const sameSourceZoom =
      target.sourceDirection === params.direction() &&
      Math.abs(nextZoom - params.previewZoom.value) <= 0.000001
    if (sameSourceZoom && !params.waveformPlaybackActive()) return
    const playbackZoomActive = params.waveformPlaybackActive()
    const anchorRatio = Math.max(0, Math.min(1, Number(target.anchorRatio) || 0))
    const sourceOwnsDeck = target.sourceDirection === params.direction()
    const targetAnchorSec =
      sourceOwnsDeck && isFiniteNumber(target.anchorSec) ? Number(target.anchorSec) : null
    const targetViewportStartSec =
      sourceOwnsDeck && isFiniteNumber(target.viewportStartSec)
        ? Number(target.viewportStartSec)
        : null
    const previousVisible = params.resolveVisibleDurationSec()
    const anchorSec =
      targetAnchorSec !== null
        ? targetAnchorSec
        : playbackZoomActive
          ? params.resolveWaveformCurrentSeconds()
          : params.previewStartSec.value + previousVisible * anchorRatio
    params.previewZoom.value = nextZoom
    const nextVisible = params.resolveVisibleDurationSec()
    const nextAnchorRatio = playbackZoomActive
      ? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
      : anchorRatio
    params.previewStartSec.value = params.clampPreviewStart(
      targetViewportStartSec ?? anchorSec - nextVisible * nextAnchorRatio
    )
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(anchorSec)
    if (playbackZoomActive) {
      params.schedulePlaybackStableFrameRender()
    } else {
      params.clearPlaybackStableFrameRenderTimer()
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }
  }

  const handleSharedZoomState = (state: HorizontalBrowseSharedZoomState | undefined) => {
    if (isZoomOwner(params.presentationState())) return
    applyZoomTarget({
      value: state?.value,
      anchorRatio: Number(state?.anchorRatio ?? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO),
      sourceDirection: state?.sourceDirection ?? null
    })
  }

  const handlePresentationState = (
    state: HorizontalBrowseWaveformPresentationState | undefined
  ) => {
    if (!state || state.revision <= consumedPresentationRevision) return
    consumedPresentationRevision = state.revision
    if (
      state.owner === 'seek' &&
      state.sourceDeck === params.deck() &&
      isFiniteNumber(state.anchorSec)
    ) {
      params.applyPresentationSeekTarget(Number(state.anchorSec), state.revision)
      return
    }
    if (isZoomOwner(state)) {
      applyZoomTarget({
        value: state.zoom,
        anchorRatio: state.anchorRatio,
        sourceDirection: resolveDeckDirection(state.sourceDeck),
        anchorSec: state.anchorSec,
        viewportStartSec: state.viewportStartSec
      })
    }
  }

  return {
    handleSharedZoomState,
    handlePresentationState
  }
}
