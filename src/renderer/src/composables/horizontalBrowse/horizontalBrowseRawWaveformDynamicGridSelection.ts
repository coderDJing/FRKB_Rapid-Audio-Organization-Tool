import { ref, watch, type Ref } from 'vue'

type DynamicGridAdjustmentScope = 'whole' | 'after'

export type HorizontalBrowseRawWaveformDynamicGridSelectionState = {
  selectedBoundarySec: Ref<number | null>
  selectedVisibleFromSec: Ref<number | null>
  selectedAdjustmentScope: Ref<DynamicGridAdjustmentScope>
}

type DynamicGridSelectionSource = {
  selectedBoundarySec: Ref<number | null>
  selectedClipVisibleFromSec: Ref<number | null>
  adjustmentScope: Ref<DynamicGridAdjustmentScope>
}

type WatchDynamicGridSelectionParams = {
  source: DynamicGridSelectionSource
  selection: HorizontalBrowseRawWaveformDynamicGridSelectionState
  forceFrameRefresh: () => void
  scheduleGridOverlayDraw: () => void
  emitToolbarState: () => void
}

const normalizeDynamicSelectionSec = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const dynamicSelectionSecChanged = (left: number | null, right: number | null) => {
  if (left === null || right === null) return left !== right
  return Math.abs(left - right) > 0.000001
}

export const createHorizontalBrowseRawWaveformDynamicGridSelectionState =
  (): HorizontalBrowseRawWaveformDynamicGridSelectionState => ({
    selectedBoundarySec: ref(null),
    selectedVisibleFromSec: ref(null),
    selectedAdjustmentScope: ref('whole')
  })

export const watchHorizontalBrowseRawWaveformDynamicGridSelection = (
  params: WatchDynamicGridSelectionParams
) =>
  watch(
    () =>
      [
        params.source.selectedBoundarySec.value,
        params.source.selectedClipVisibleFromSec.value,
        params.source.adjustmentScope.value
      ] as const,
    ([boundarySec, visibleFromSec, scope]) => {
      const nextBoundarySec = normalizeDynamicSelectionSec(boundarySec)
      const nextVisibleFromSec = normalizeDynamicSelectionSec(visibleFromSec)
      const nextScope = scope === 'after' ? 'after' : 'whole'
      const boundaryChanged = dynamicSelectionSecChanged(
        params.selection.selectedBoundarySec.value,
        nextBoundarySec
      )
      const visibleChanged = dynamicSelectionSecChanged(
        params.selection.selectedVisibleFromSec.value,
        nextVisibleFromSec
      )
      const scopeChanged = params.selection.selectedAdjustmentScope.value !== nextScope
      if (!boundaryChanged && !visibleChanged && !scopeChanged) return
      params.selection.selectedBoundarySec.value = nextBoundarySec
      params.selection.selectedVisibleFromSec.value = nextVisibleFromSec
      params.selection.selectedAdjustmentScope.value = nextScope
      if (visibleChanged) {
        params.forceFrameRefresh()
      } else {
        params.scheduleGridOverlayDraw()
      }
      params.emitToolbarState()
    },
    { immediate: true }
  )
