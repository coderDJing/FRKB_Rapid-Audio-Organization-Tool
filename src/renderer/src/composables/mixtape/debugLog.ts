const MIXTAPE_GRID_DEBUG_ENABLED = true
const MIXTAPE_GRID_DEBUG_PREFIX = '[mixtape-grid-debug]'

const safeSerializeLogPayload = (payload: unknown) => {
  const seen = new WeakSet<object>()
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Number(value.toFixed(4)) : value
    }
    if (typeof value === 'string') {
      return value.length > 220 ? `${value.slice(0, 220)}...` : value
    }
    if (Array.isArray(value) && value.length > 16) {
      return [...value.slice(0, 16), `...(${value.length - 16} more)`]
    }
    if (value && typeof value === 'object') {
      if (seen.has(value as object)) return '[circular]'
      seen.add(value as object)
    }
    return value
  })
}

export const outputMixtapeGridDebugLog = (event: string, payload?: unknown) => {
  if (!MIXTAPE_GRID_DEBUG_ENABLED) return
  const eventName = String(event || '').trim() || 'unknown'
  const suffix =
    payload === undefined ? '' : ` ${safeSerializeLogPayload(payload) || String(payload)}`
  const message = `${MIXTAPE_GRID_DEBUG_PREFIX} ${eventName}${suffix}`
  try {
    window.electron?.ipcRenderer?.send('outputLog', message)
  } catch (error) {
    console.error(`${MIXTAPE_GRID_DEBUG_PREFIX} failed`, error, { event: eventName, payload })
  }
}
