import type { ISongHotCue } from '../types/globals'

export const HOT_CUE_SLOT_COUNT = 8
export const HOT_CUE_SLOT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
export const HOT_CUE_SLOT_COLORS = [
  '#20c997',
  '#2f80ed',
  '#9b51e0',
  '#eb5757',
  '#f2994a',
  '#f2c94c',
  '#27ae60',
  '#56ccf2'
] as const

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const resolveSongHotCueLabel = (slot: number) =>
  HOT_CUE_SLOT_LABELS[clampNumber(Math.floor(Number(slot) || 0), 0, HOT_CUE_SLOT_COUNT - 1)] || ''

export const resolveSongHotCueColor = (slot: number) =>
  HOT_CUE_SLOT_COLORS[clampNumber(Math.floor(Number(slot) || 0), 0, HOT_CUE_SLOT_COUNT - 1)] ||
  HOT_CUE_SLOT_COLORS[0]

export const normalizeSongHotCueSlot = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= HOT_CUE_SLOT_COUNT) return null
  return numeric
}

export const normalizeSongHotCueSec = (value: unknown, durationSec?: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const bounded =
    Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
      ? clampNumber(numeric, 0, Number(durationSec))
      : Math.max(0, numeric)
  return Number(bounded.toFixed(3))
}

export const normalizeSongHotCues = (value: unknown, durationSec?: number): ISongHotCue[] => {
  if (!Array.isArray(value)) return []
  const normalizedBySlot = new Map<number, ISongHotCue>()
  for (const item of value) {
    const slot =
      item && typeof item === 'object' && !Array.isArray(item)
        ? normalizeSongHotCueSlot((item as { slot?: unknown }).slot)
        : null
    const sec =
      item && typeof item === 'object' && !Array.isArray(item)
        ? normalizeSongHotCueSec((item as { sec?: unknown }).sec, durationSec)
        : null
    if (slot === null || sec === null) continue
    normalizedBySlot.set(slot, { slot, sec })
  }
  return Array.from(normalizedBySlot.values()).sort((left, right) => left.slot - right.slot)
}

export const resolveSongHotCueBySlot = (value: unknown, slot: number, durationSec?: number) =>
  normalizeSongHotCues(value, durationSec).find((item) => item.slot === slot) || null

export const upsertSongHotCue = (
  value: unknown,
  slot: number,
  sec: number,
  durationSec?: number
) => {
  const normalizedSlot = normalizeSongHotCueSlot(slot)
  const normalizedSec = normalizeSongHotCueSec(sec, durationSec)
  if (normalizedSlot === null || normalizedSec === null) {
    return normalizeSongHotCues(value, durationSec)
  }
  const next = normalizeSongHotCues(value, durationSec)
  const nextIndex = next.findIndex((item) => item.slot === normalizedSlot)
  if (nextIndex >= 0) {
    next[nextIndex] = { slot: normalizedSlot, sec: normalizedSec }
  } else {
    next.push({ slot: normalizedSlot, sec: normalizedSec })
  }
  return next.sort((left, right) => left.slot - right.slot)
}

export const removeSongHotCue = (value: unknown, slot: number, durationSec?: number) => {
  const normalizedSlot = normalizeSongHotCueSlot(slot)
  if (normalizedSlot === null) return normalizeSongHotCues(value, durationSec)
  return normalizeSongHotCues(value, durationSec).filter((item) => item.slot !== normalizedSlot)
}

export const areSongHotCuesEqual = (left: unknown, right: unknown, durationSec?: number) => {
  const normalizedLeft = normalizeSongHotCues(left, durationSec)
  const normalizedRight = normalizeSongHotCues(right, durationSec)
  if (normalizedLeft.length !== normalizedRight.length) return false
  return normalizedLeft.every((item, index) => {
    const next = normalizedRight[index]
    return !!next && next.slot === item.slot && Math.abs(next.sec - item.sec) <= 0.0001
  })
}

export const formatSongHotCueTime = (value: unknown) => {
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

export const resolveNearestHotCueGridSec = (params: {
  currentSec: number
  durationSec?: number
  bpm?: number
  firstBeatMs?: number
}) => {
  const durationSec = Number(params.durationSec)
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined
  const safeCurrent = normalizeSongHotCueSec(params.currentSec, safeDuration)
  if (safeCurrent === null) return null

  const bpm = Number(params.bpm)
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return safeCurrent
  }
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) {
    return safeCurrent
  }

  const firstBeatSec = Math.max(0, Number(params.firstBeatMs) || 0) / 1000
  const nearestBeatIndex = Math.round((safeCurrent - firstBeatSec) / beatSec)
  const snapped =
    firstBeatSec + nearestBeatIndex * beatSec < 0 ? 0 : firstBeatSec + nearestBeatIndex * beatSec
  const candidate = normalizeSongHotCueSec(snapped, safeDuration)
  if (candidate === null) return safeCurrent

  const zeroDistance = Math.abs(safeCurrent)
  const snappedDistance = Math.abs(safeCurrent - candidate)
  return zeroDistance <= snappedDistance ? 0 : candidate
}
