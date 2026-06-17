import type { Ref } from 'vue'
import type { HorizontalBrowseDragSessionEndPayload } from './horizontalBrowseRawWaveformDetailTypes'

type DragPresentationStartResult = {
  viewportStartSec: number | null
}

type DragPresentationEndResult = {
  requiresRender: boolean
}

type PointerInteractionOptions = {
  wrapRef: Ref<HTMLDivElement | null>
  dragging: Ref<boolean>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  previewMaxZoom: Ref<number>
  direction: () => 'up' | 'down'
  hasSong: () => boolean
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  resolvePreviewAnchorSec: () => number
  clampPreviewStart: (seconds: number) => number
  beginDragCanvasPresentation: () => DragPresentationStartResult
  applyDragCanvasPresentationOffset: (offsetCssPx: number) => void
  endDragCanvasPresentation: (viewportStartSec?: number) => DragPresentationEndResult
  clearDragReleaseHandoff: () => void
  beginDragReleaseHandoff: (anchorSec: number) => void
  scrubPreview: {
    start: (anchorSec: number) => void
    update: (anchorSec: number) => void
    stop: () => void
  }
  handlePreviewMouseDownForBarLinePicking: (event: PointerEvent) => boolean
  emitToolbarState: () => void
  schedulePersistGridDefinition: () => void
  emitDragSessionStart: () => void
  emitDragSessionEnd: (payload: HorizontalBrowseDragSessionEndPayload) => void
  emitZoomChange: (payload: {
    value: number
    anchorRatio: number
    sourceDirection: 'up' | 'down'
  }) => void
  maybeContinueWaveformSource: (anchorSec?: number) => void
  drawWaveformNow: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  scheduleDraw: () => void
  zoomStepFactor: number
  minZoom: number
  clampNumber: (value: number, min: number, max: number) => number
}

export const createHorizontalBrowseWaveformPointerInteraction = (
  options: PointerInteractionOptions
) => {
  let dragStartClientX = 0
  let dragStartSec = 0
  let activeDragPointerId: number | null = null

  const handleDragPointerMove = (event: PointerEvent) => {
    if (!options.dragging.value) return
    if (activeDragPointerId !== null && event.pointerId !== activeDragPointerId) return
    if (event.pointerType === 'touch') {
      event.preventDefault()
    }
    const wrap = options.wrapRef.value
    if (!wrap) return
    const visibleDuration = options.resolveVisibleDurationSec()
    if (!visibleDuration) return
    const deltaX = event.clientX - dragStartClientX
    const deltaSec = (deltaX / Math.max(1, wrap.clientWidth)) * visibleDuration
    options.previewStartSec.value = options.clampPreviewStart(dragStartSec - deltaSec)
    const presentationOffset =
      ((dragStartSec - options.previewStartSec.value) / visibleDuration) *
      Math.max(1, wrap.clientWidth)
    options.applyDragCanvasPresentationOffset(presentationOffset)
    options.scrubPreview.update(options.resolvePreviewAnchorSec())
  }

  const stopDragging = (commitPlayhead = false, refreshWaveform = true) => {
    if (!options.dragging.value) return
    const finalAnchorSec = options.resolvePreviewAnchorSec()
    const finalPreviewStartSec = options.previewStartSec.value
    const committed = commitPlayhead && options.hasSong()
    if (committed && refreshWaveform) {
      options.beginDragReleaseHandoff(finalAnchorSec)
    } else {
      options.clearDragReleaseHandoff()
    }
    options.dragging.value = false
    activeDragPointerId = null
    options.scrubPreview.stop()
    const dragRelease = options.endDragCanvasPresentation(finalPreviewStartSec)
    window.removeEventListener('pointermove', handleDragPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
    window.removeEventListener('pointercancel', handleWindowPointerCancel)
    options.emitDragSessionEnd({
      anchorSec: finalAnchorSec,
      committed
    })
    if (refreshWaveform) {
      options.maybeContinueWaveformSource(finalAnchorSec)
      if (dragRelease.requiresRender) {
        options.drawWaveformNow({ preferPreviewStart: true, viewportOnly: true })
      }
    }
  }

  const beginWaveformDrag = (event: PointerEvent) => {
    options.clearDragReleaseHandoff()
    options.dragging.value = true
    activeDragPointerId = event.pointerId
    dragStartClientX = event.clientX
    options.emitDragSessionStart()
    const dragPresentation = options.beginDragCanvasPresentation()
    const visualStartSec = dragPresentation.viewportStartSec
    dragStartSec =
      visualStartSec !== null && Number.isFinite(visualStartSec)
        ? options.clampPreviewStart(visualStartSec)
        : options.previewStartSec.value
    options.previewStartSec.value = dragStartSec
    options.scrubPreview.start(options.resolvePreviewAnchorSec())
    window.addEventListener('pointermove', handleDragPointerMove, { passive: false })
    window.addEventListener('pointerup', handleWindowPointerUp, { passive: true })
    window.addEventListener('pointercancel', handleWindowPointerCancel, { passive: true })
  }

  const handleWindowPointerUp = (event: PointerEvent) => {
    if (activeDragPointerId !== null && event.pointerId !== activeDragPointerId) return
    handleDragPointerMove(event)
    stopDragging(true)
  }

  const handleWindowPointerCancel = (event: PointerEvent) => {
    if (activeDragPointerId !== null && event.pointerId !== activeDragPointerId) return
    stopDragging(false)
  }

  const handlePointerDown = (event: PointerEvent) => {
    const durationSec = options.resolvePreviewDurationSec()
    if (event.button !== 0 || options.dragging.value) return
    if (!options.hasSong() || !durationSec) return
    const barLinePicked = options.handlePreviewMouseDownForBarLinePicking(event)
    if (barLinePicked) {
      options.emitToolbarState()
      options.schedulePersistGridDefinition()
      return
    }
    beginWaveformDrag(event)
    event.preventDefault()
  }

  const handleWheel = (event: WheelEvent) => {
    const wrap = options.wrapRef.value
    const duration = options.resolvePreviewDurationSec()
    if (!wrap || !duration) return

    event.preventDefault()
    const rect = wrap.getBoundingClientRect()
    const ratio =
      rect.width > 0 ? options.clampNumber((event.clientX - rect.left) / rect.width, 0, 1) : 0.5
    const beforeVisible = options.resolveVisibleDurationSec()
    const anchorSec = options.previewStartSec.value + beforeVisible * ratio
    const factor = event.deltaY < 0 ? options.zoomStepFactor : 1 / options.zoomStepFactor
    const nextZoom = options.clampNumber(
      options.previewZoom.value * factor,
      options.minZoom,
      options.previewMaxZoom.value
    )
    if (Math.abs(nextZoom - options.previewZoom.value) <= 0.000001) return

    options.previewZoom.value = nextZoom
    const nextVisible = options.resolveVisibleDurationSec()
    options.previewStartSec.value = options.clampPreviewStart(anchorSec - nextVisible * ratio)
    options.emitZoomChange({
      value: options.previewZoom.value,
      anchorRatio: ratio,
      sourceDirection: options.direction()
    })
    options.maybeContinueWaveformSource(options.resolvePreviewAnchorSec())
    options.scheduleDraw()
  }

  return {
    stopDragging,
    handlePointerDown,
    handleWheel
  }
}
