type ClickThroughGuardOptions = {
  windowMs?: number
  maxDistancePx?: number
}

type PendingClick = {
  x: number
  y: number
  expiresAt: number
}

const DEFAULT_WINDOW_MS = 360
const DEFAULT_MAX_DISTANCE_PX = 12

export const createClickThroughGuard = (options: ClickThroughGuardOptions = {}) => {
  const windowMs = Math.max(16, Number(options.windowMs) || DEFAULT_WINDOW_MS)
  const maxDistancePx = Math.max(1, Number(options.maxDistancePx) || DEFAULT_MAX_DISTANCE_PX)
  const maxDistanceSq = maxDistancePx * maxDistancePx
  let pendingClick: PendingClick | null = null

  const clear = () => {
    pendingClick = null
  }

  const markFromPointer = (event: PointerEvent | MouseEvent) => {
    pendingClick = {
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      expiresAt: Date.now() + windowMs
    }
  }

  const shouldSuppressClick = (event: MouseEvent) => {
    if (!pendingClick) return false
    if (Date.now() > pendingClick.expiresAt) {
      pendingClick = null
      return false
    }
    const dx = (Number(event.clientX) || 0) - pendingClick.x
    const dy = (Number(event.clientY) || 0) - pendingClick.y
    const withinRange = dx * dx + dy * dy <= maxDistanceSq
    if (!withinRange) return false
    pendingClick = null
    return true
  }

  const suppressClickIfNeeded = (event: MouseEvent) => {
    if (!shouldSuppressClick(event)) return false
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    return true
  }

  return {
    clear,
    markFromPointer,
    suppressClickIfNeeded
  }
}

