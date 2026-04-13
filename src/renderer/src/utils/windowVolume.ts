export const DEFAULT_WINDOW_VOLUME = 0.8
export const MAIN_WINDOW_VOLUME_STORAGE_KEY = 'frkb_main_window_volume'
export const MIXTAPE_WINDOW_VOLUME_STORAGE_KEY = 'frkb_mixtape_window_volume'
export const MAIN_WINDOW_VOLUME_SET_EVENT = 'main-window-volume:set'
export const MAIN_WINDOW_VOLUME_CHANGED_EVENT = 'main-window-volume:changed'

export const clampVolumeValue = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_VOLUME
  return Math.min(1, Math.max(0, value))
}

export const readWindowVolume = (storageKey: string) => {
  try {
    const raw = localStorage.getItem(storageKey)
    const parsed = raw !== null ? Number.parseFloat(raw) : Number.NaN
    return clampVolumeValue(parsed)
  } catch {
    return DEFAULT_WINDOW_VOLUME
  }
}

export const writeWindowVolume = (storageKey: string, value: number) => {
  const safeValue = clampVolumeValue(value)
  try {
    localStorage.setItem(storageKey, String(safeValue))
  } catch {}
  return safeValue
}

export const formatVolumePercent = (value: number) =>
  `${Math.round(clampVolumeValue(value) * 100)}%`
