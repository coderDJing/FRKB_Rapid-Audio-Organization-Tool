export function normalizeAddedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? Math.floor(numeric * 1000) : Math.floor(numeric)
  }
  const parsed = Date.parse(trimmed.replace(' ', 'T'))
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return undefined
}

export function preserveCachedAddedAtMs(
  target: { addedAtMs?: number },
  cachedInfo?: { addedAtMs?: number } | null
) {
  if (normalizeAddedAtMs(target.addedAtMs) !== undefined) return
  const cached = normalizeAddedAtMs(cachedInfo?.addedAtMs)
  if (cached !== undefined) target.addedAtMs = cached
}

const FILTER_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/

/** 筛选条件解析结果。旧数据可能只有日期，新选择器会带上时分秒。 */

export type FilterDateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  hasTime: boolean
}

function padDateTimePart(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function isValidHms(hour: number, minute: number, second: number): boolean {
  return (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59 &&
    Number.isInteger(second) &&
    second >= 0 &&
    second <= 59
  )
}

export function parseFilterDateTime(value: unknown): FilterDateTimeParts | undefined {
  const match = FILTER_DATETIME_RE.exec(String(value || '').trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!isValidYmd(year, month, day)) return undefined
  const hasTime = match[4] !== undefined
  const hour = hasTime ? Number(match[4]) : 0
  const minute = hasTime ? Number(match[5]) : 0
  const second = hasTime ? Number(match[6] ?? '0') : 0
  if (hasTime && !isValidHms(hour, minute, second)) return undefined
  return { year, month, day, hour, minute, second, hasTime }
}

export function formatFilterDateTime(
  parts: Omit<FilterDateTimeParts, 'hasTime'>,
  withTime = true
): string {
  const date = `${padDateTimePart(parts.year, 4)}-${padDateTimePart(parts.month)}-${padDateTimePart(parts.day)}`
  if (!withTime) return date
  return `${date} ${padDateTimePart(parts.hour)}:${padDateTimePart(parts.minute)}:${padDateTimePart(parts.second)}`
}

export function normalizeFilterDate(value: unknown): string | undefined {
  const parts = parseFilterDateTime(value)
  if (!parts) return undefined
  return formatFilterDateTime(parts, parts.hasTime)
}

export function resolveLocalDateRangeMs(
  dateStr: unknown
): { startMs: number; endMs: number } | null {
  const parts = parseFilterDateTime(dateStr)
  if (!parts) return null
  const startMs = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hasTime ? parts.hour : 0,
    parts.hasTime ? parts.minute : 0,
    parts.hasTime ? parts.second : 0,
    0
  ).getTime()
  const endMs = parts.hasTime
    ? startMs + 999
    : new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}

export type DateFilterOp = 'eq' | 'gte' | 'lte' | 'between'

export function orderFilterDateRange(
  fromValue: unknown,
  toValue: unknown
): { from: string; to: string } | undefined {
  const from = normalizeFilterDate(fromValue)
  const to = normalizeFilterDate(toValue)
  if (!from || !to) return undefined
  const fromRange = resolveLocalDateRangeMs(from)
  const toRange = resolveLocalDateRangeMs(to)
  if (!fromRange || !toRange) return undefined
  if (fromRange.startMs <= toRange.startMs) return { from, to }
  return { from: to, to: from }
}

export function resolveFilterDateBounds(
  fromValue: unknown,
  toValue: unknown
): { from?: string; to?: string } {
  const from = normalizeFilterDate(fromValue)
  const to = normalizeFilterDate(toValue)
  if (from && to) return orderFilterDateRange(from, to) || { from, to }
  if (from) return { from }
  if (to) return { to }
  return {}
}

export function matchTimestampByDateFilter(
  timestampMs: unknown,
  op: DateFilterOp | undefined,
  dateStr: unknown,
  dateToStr?: unknown
): boolean {
  const value = normalizeAddedAtMs(timestampMs)
  if (value === undefined || !op) return false
  if (op === 'between') {
    const fromRange = resolveLocalDateRangeMs(dateStr)
    const toRange = resolveLocalDateRangeMs(dateToStr)
    if (fromRange && toRange) {
      const startMs = Math.min(fromRange.startMs, toRange.startMs)
      const endMs = Math.max(fromRange.endMs, toRange.endMs)
      return value >= startMs && value <= endMs
    }
    if (fromRange) return value >= fromRange.startMs
    if (toRange) return value <= toRange.endMs
    return false
  }
  const range = resolveLocalDateRangeMs(dateStr)
  if (!range) return false
  if (op === 'eq') return value >= range.startMs && value <= range.endMs
  if (op === 'gte') return value >= range.startMs
  if (op === 'lte') return value <= range.endMs
  return false
}
