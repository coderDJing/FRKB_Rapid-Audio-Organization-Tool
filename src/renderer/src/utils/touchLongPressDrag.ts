const DEFAULT_TOUCH_DRAG_DELAY_MS = 200
const DEFAULT_TOUCH_DRAG_MOVE_TOLERANCE_PX = 8

type DragPoint = {
  clientX: number
  clientY: number
  screenX: number
  screenY: number
}

type TouchDragState = {
  sourceElement: HTMLElement
  touchId: number
  startPoint: DragPoint
  latestPoint: DragPoint
  timer: ReturnType<typeof setTimeout> | null
  active: boolean
  dataTransfer: DataTransfer | null
  lastTarget: Element | null
  originalDraggableAttr: string | null
}

type TouchLongPressDragOptions = {
  delayMs?: number
  moveTolerancePx?: number
}

const touchListenerOptions: AddEventListenerOptions = {
  capture: true,
  passive: false
}

const isInteractiveTouchTarget = (target: EventTarget | null) => {
  const element = target instanceof Element ? target : null
  if (!element) return false
  return Boolean(
    element.closest(
      'button,input,textarea,select,a,[contenteditable="true"],[data-touch-drag-ignore]'
    )
  )
}

const getTouchPoint = (touch: Touch): DragPoint => ({
  clientX: touch.clientX,
  clientY: touch.clientY,
  screenX: touch.screenX,
  screenY: touch.screenY
})

const findTouchById = (touches: TouchList, touchId: number): Touch | null => {
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches.item(i)
    if (touch?.identifier === touchId) return touch
  }
  return null
}

const getDistance = (from: DragPoint, to: DragPoint) => {
  const dx = to.clientX - from.clientX
  const dy = to.clientY - from.clientY
  return Math.sqrt(dx * dx + dy * dy)
}

const createDataTransfer = (): DataTransfer | null => {
  if (typeof DataTransfer !== 'function') return null
  try {
    return new DataTransfer()
  } catch {
    return null
  }
}

const createDragEvent = (
  type: 'dragstart' | 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  state: TouchDragState,
  point: DragPoint
) =>
  new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: point.screenX,
    screenY: point.screenY,
    buttons: 1,
    dataTransfer: state.dataTransfer
  })

const dispatchDragEvent = (
  target: EventTarget,
  type: 'dragstart' | 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  state: TouchDragState,
  point: DragPoint
) => {
  const event = createDragEvent(type, state, point)
  target.dispatchEvent(event)
  return event
}

export const createTouchLongPressDrag = (options: TouchLongPressDragOptions = {}) => {
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_TOUCH_DRAG_DELAY_MS)
  const moveTolerancePx = Math.max(
    0,
    options.moveTolerancePx ?? DEFAULT_TOUCH_DRAG_MOVE_TOLERANCE_PX
  )
  let state: TouchDragState | null = null

  const clearTimer = () => {
    if (!state?.timer) return
    clearTimeout(state.timer)
    state.timer = null
  }

  const restoreSourceDraggable = (targetState: TouchDragState) => {
    if (targetState.originalDraggableAttr === null) {
      targetState.sourceElement.removeAttribute('draggable')
      return
    }
    targetState.sourceElement.setAttribute('draggable', targetState.originalDraggableAttr)
  }

  const removeWindowListeners = () => {
    window.removeEventListener('touchmove', handleWindowTouchMove, touchListenerOptions)
    window.removeEventListener('touchend', handleWindowTouchEnd, touchListenerOptions)
    window.removeEventListener('touchcancel', handleWindowTouchCancel, touchListenerOptions)
    window.removeEventListener('blur', handleWindowBlur)
  }

  const finish = (dispatchEnd: boolean) => {
    const current = state
    if (!current) return
    clearTimer()
    if (dispatchEnd && current.active) {
      dispatchDragEvent(current.sourceElement, 'dragend', current, current.latestPoint)
    }
    restoreSourceDraggable(current)
    state = null
    removeWindowListeners()
  }

  const resolveCurrentTarget = (targetState: TouchDragState) =>
    document.elementFromPoint(targetState.latestPoint.clientX, targetState.latestPoint.clientY)

  const dispatchTargetMove = () => {
    const current = state
    if (!current?.active) return
    const target = resolveCurrentTarget(current)
    if (!target) return
    if (current.lastTarget !== target) {
      if (current.lastTarget) {
        dispatchDragEvent(current.lastTarget, 'dragleave', current, current.latestPoint)
      }
      dispatchDragEvent(target, 'dragenter', current, current.latestPoint)
      current.lastTarget = target
    }
    dispatchDragEvent(target, 'dragover', current, current.latestPoint)
  }

  const activate = () => {
    const current = state
    if (!current || current.active) return
    current.timer = null
    current.dataTransfer = createDataTransfer()
    if (!current.dataTransfer) {
      finish(false)
      return
    }
    current.active = true
    const startEvent = dispatchDragEvent(
      current.sourceElement,
      'dragstart',
      current,
      current.latestPoint
    )
    if (startEvent.defaultPrevented) {
      finish(false)
      return
    }
    dispatchTargetMove()
  }

  const updateLatestTouch = (event: TouchEvent): Touch | null => {
    const current = state
    if (!current) return null
    const touch =
      findTouchById(event.touches, current.touchId) ||
      findTouchById(event.changedTouches, current.touchId)
    if (!touch) return null
    current.latestPoint = getTouchPoint(touch)
    return touch
  }

  function handleWindowTouchMove(event: TouchEvent) {
    const current = state
    if (!current) return
    const touch = updateLatestTouch(event)
    if (!touch) return
    if (!current.active) {
      if (getDistance(current.startPoint, current.latestPoint) > moveTolerancePx) {
        finish(false)
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    dispatchTargetMove()
  }

  function handleWindowTouchEnd(event: TouchEvent) {
    const current = state
    if (!current) return
    const touch = updateLatestTouch(event)
    if (!touch && !findTouchById(event.changedTouches, current.touchId)) return
    if (current.active) {
      event.preventDefault()
      event.stopPropagation()
      const target = resolveCurrentTarget(current)
      if (target) {
        dispatchDragEvent(target, 'drop', current, current.latestPoint)
      }
      finish(true)
      return
    }
    finish(false)
  }

  function handleWindowTouchCancel(event: TouchEvent) {
    if (!state) return
    updateLatestTouch(event)
    if (state.active) {
      event.preventDefault()
      event.stopPropagation()
    }
    finish(true)
  }

  function handleWindowBlur() {
    finish(true)
  }

  const handleTouchStart = (event: TouchEvent, sourceElement: HTMLElement) => {
    if (event.touches.length !== 1 || isInteractiveTouchTarget(event.target)) return
    finish(false)
    const touch = event.touches.item(0)
    if (!touch) return
    const point = getTouchPoint(touch)
    state = {
      sourceElement,
      touchId: touch.identifier,
      startPoint: point,
      latestPoint: point,
      timer: null,
      active: false,
      dataTransfer: null,
      lastTarget: null,
      originalDraggableAttr: sourceElement.getAttribute('draggable')
    }
    sourceElement.draggable = false
    window.addEventListener('touchmove', handleWindowTouchMove, touchListenerOptions)
    window.addEventListener('touchend', handleWindowTouchEnd, touchListenerOptions)
    window.addEventListener('touchcancel', handleWindowTouchCancel, touchListenerOptions)
    window.addEventListener('blur', handleWindowBlur)
    state.timer = setTimeout(activate, delayMs)
  }

  return {
    handleTouchStart,
    cancel: () => finish(true)
  }
}
