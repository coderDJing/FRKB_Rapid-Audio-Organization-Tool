import type { Directive, DirectiveBinding } from 'vue'

type BindingValue = string | undefined | null

interface DragMeta {
  handle: HTMLElement
  pointerDownHandler: (event: PointerEvent) => void
  remove: () => void
}

const contexts = new WeakMap<HTMLElement, DragMeta>()

const shouldIgnoreDrag = (event: PointerEvent): boolean => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-dialog-drag-ignore]')) return true
  if (target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return true
  return false
}

const getHandleElement = (el: HTMLElement, binding: DirectiveBinding<BindingValue>) => {
  if (!binding.value) return el
  try {
    return (el.querySelector(binding.value) as HTMLElement) || el
  } catch (error) {
    console.warn('[dialog-drag] 无法解析选择器:', binding.value, error)
    return el
  }
}

const mountDialogDrag = (el: HTMLElement, binding: DirectiveBinding<BindingValue>) => {
  const handle = getHandleElement(el, binding)

  const pointerMoveHandler = (event: PointerEvent) => {
    const context = contexts.get(el)
    if (!context || context.handle !== handle) return
    const state = (context as any)._state as {
      pointerId: number
      startClientX: number
      startClientY: number
      baseTranslateX: number
      baseTranslateY: number
      initialTop: number
    }
    if (!state || event.pointerId !== state.pointerId) return

    event.preventDefault()

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    if (
      event.clientX < 0 ||
      event.clientX > viewportWidth ||
      event.clientY < 0 ||
      event.clientY > viewportHeight
    ) {
      pointerUpHandler(event)
      return
    }

    const deltaX = event.clientX - state.startClientX
    const deltaY = event.clientY - state.startClientY

    const nextX = state.baseTranslateX + deltaX
    let nextY = state.baseTranslateY + deltaY

    const TITLE_BAR_SAFE_ZONE = 35
    const currentTop = state.initialTop + nextY
    if (currentTop < TITLE_BAR_SAFE_ZONE) {
      nextY = TITLE_BAR_SAFE_ZONE - state.initialTop
    }

    el.style.transform = `translate(${nextX}px, ${nextY}px)`
    el.dataset.dragTranslateX = String(nextX)
    el.dataset.dragTranslateY = String(nextY)
  }

  const clearDragState = () => {
    document.removeEventListener('pointermove', pointerMoveHandler)
    document.removeEventListener('pointerup', pointerUpHandler)
    document.removeEventListener('pointercancel', pointerUpHandler)
    document.body.style.userSelect = handle.dataset.dragPrevUserSelect || ''
    delete handle.dataset.dragPrevUserSelect
    const overlay = (contexts.get(el) as any)?._overlay as HTMLElement | undefined
    overlay?.classList.remove('dialog--dragging')
  }

  const pointerUpHandler = (event: PointerEvent) => {
    const context = contexts.get(el)
    if (!context) return
    const state = (context as any)._state
    if (!state || event.pointerId !== state.pointerId) return

    clearDragState()
    try {
      handle.releasePointerCapture(state.pointerId)
    } catch {}
  }

  const pointerDownHandler = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (shouldIgnoreDrag(event)) return
    const overlayCandidate = el.closest('.dialog') as HTMLElement | null
    if (!overlayCandidate) return
    let overlay = overlayCandidate
    if (overlay.parentElement?.classList.contains('dialog')) {
      overlay = overlay.parentElement as HTMLElement
    }
    const elRect = el.getBoundingClientRect()
    const currentX = Number(el.dataset.dragTranslateX || 0)
    const currentY = Number(el.dataset.dragTranslateY || 0)

    const state = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseTranslateX: currentX,
      baseTranslateY: currentY,
      initialTop: elRect.top - currentY
    }

    ;(contexts.get(el) as any)._state = state
    ;(contexts.get(el) as any)._overlay = overlay

    handle.dataset.dragPrevUserSelect = document.body.style.userSelect || ''
    document.body.style.userSelect = 'none'

    overlay.classList.add('dialog--dragging')

    document.addEventListener('pointermove', pointerMoveHandler)
    document.addEventListener('pointerup', pointerUpHandler)
    document.addEventListener('pointercancel', pointerUpHandler)

    try {
      handle.setPointerCapture(event.pointerId)
    } catch {}
    event.preventDefault()
  }

  handle.style.userSelect = 'none'
  handle.style.touchAction = 'none'

  const remove = () => {
    clearDragState()
    handle.removeEventListener('pointerdown', pointerDownHandler)
  }

  handle.addEventListener('pointerdown', pointerDownHandler)

  contexts.set(el, {
    handle,
    pointerDownHandler,
    remove
  })
}

const dialogDrag: Directive<HTMLElement, BindingValue> = {
  mounted: mountDialogDrag,
  updated(el, binding) {
    const context = contexts.get(el)
    if (!context) return
    const nextHandle = getHandleElement(el, binding)
    if (nextHandle === context.handle) return

    context.remove()
    contexts.delete(el)
    mountDialogDrag(el, binding)
  },
  unmounted(el) {
    const context = contexts.get(el)
    if (!context) return
    context.remove()
    contexts.delete(el)
  }
}

export default dialogDrag
