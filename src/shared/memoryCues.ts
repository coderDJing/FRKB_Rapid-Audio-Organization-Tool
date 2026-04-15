import type { ISongMemoryCue } from '../types/globals'

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const MEMORY_CUE_EPSILON_SEC = 0.0001

export const normalizeSongMemoryCueSec = (value: unknown, durationSec?: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const bounded =
    Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
      ? clampNumber(numeric, 0, Number(durationSec))
      : Math.max(0, numeric)
  return Number(bounded.toFixed(3))
}

export const normalizeSongMemoryCues = (value: unknown, durationSec?: number): ISongMemoryCue[] => {
  if (!Array.isArray(value)) return []
  const normalized: ISongMemoryCue[] = []
  for (const item of value) {
    const sec =
      item && typeof item === 'object' && !Array.isArray(item)
        ? normalizeSongMemoryCueSec((item as { sec?: unknown }).sec, durationSec)
        : null
    if (sec === null) continue
    if (normalized.some((entry) => Math.abs(entry.sec - sec) <= MEMORY_CUE_EPSILON_SEC)) continue
    normalized.push({ sec })
  }
  return normalized.sort((left, right) => left.sec - right.sec)
}

export const upsertSongMemoryCue = (value: unknown, sec: number, durationSec?: number) => {
  const normalizedSec = normalizeSongMemoryCueSec(sec, durationSec)
  if (normalizedSec === null) return normalizeSongMemoryCues(value, durationSec)
  const next = normalizeSongMemoryCues(value, durationSec)
  if (next.some((item) => Math.abs(item.sec - normalizedSec) <= MEMORY_CUE_EPSILON_SEC)) {
    return next
  }
  next.push({ sec: normalizedSec })
  return next.sort((left, right) => left.sec - right.sec)
}

export const removeSongMemoryCue = (value: unknown, sec: number, durationSec?: number) => {
  const normalizedSec = normalizeSongMemoryCueSec(sec, durationSec)
  if (normalizedSec === null) return normalizeSongMemoryCues(value, durationSec)
  return normalizeSongMemoryCues(value, durationSec).filter(
    (item) => Math.abs(item.sec - normalizedSec) > MEMORY_CUE_EPSILON_SEC
  )
}

export const areSongMemoryCuesEqual = (left: unknown, right: unknown, durationSec?: number) => {
  const normalizedLeft = normalizeSongMemoryCues(left, durationSec)
  const normalizedRight = normalizeSongMemoryCues(right, durationSec)
  if (normalizedLeft.length !== normalizedRight.length) return false
  return normalizedLeft.every((item, index) => {
    const next = normalizedRight[index]
    return !!next && Math.abs(next.sec - item.sec) <= MEMORY_CUE_EPSILON_SEC
  })
}

export const formatSongMemoryCueTime = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return '--:--.---'
  const totalMs = Math.round(numeric * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const milliseconds = totalMs % 1000
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}
