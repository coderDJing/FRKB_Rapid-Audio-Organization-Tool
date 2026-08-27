import { describe, expect, it } from 'vitest'
import {
  matchTimestampByDateFilter,
  normalizeAddedAtMs,
  normalizeFilterDate,
  orderFilterDateRange,
  preserveCachedAddedAtMs,
  resolveFilterDateBounds
} from './songAddedAt'

describe('normalizeAddedAtMs', () => {
  it('接受正整数毫秒', () => {
    expect(normalizeAddedAtMs(1700000000000)).toBe(1700000000000)
  })

  it('拒绝 0 和无效值', () => {
    expect(normalizeAddedAtMs(0)).toBeUndefined()
    expect(normalizeAddedAtMs('')).toBeUndefined()
    expect(normalizeAddedAtMs(undefined)).toBeUndefined()
    expect(normalizeAddedAtMs('not-a-date')).toBeUndefined()
  })

  it('解析 ISO 日期字符串', () => {
    expect(normalizeAddedAtMs('2024-01-15T12:00:00.000Z')).toBe(
      Date.parse('2024-01-15T12:00:00.000Z')
    )
  })
})

describe('preserveCachedAddedAtMs', () => {
  it('目标已有有效值时不覆盖', () => {
    const target = { addedAtMs: 200 }
    preserveCachedAddedAtMs(target, { addedAtMs: 100 })
    expect(target.addedAtMs).toBe(200)
  })

  it('目标缺失时从缓存补上', () => {
    const target: { addedAtMs?: number } = {}
    preserveCachedAddedAtMs(target, { addedAtMs: 100 })
    expect(target.addedAtMs).toBe(100)
  })
})

describe('matchTimestampByDateFilter', () => {
  const midday = new Date(2026, 7, 26, 12, 0, 0, 0).getTime()
  const before = new Date(2026, 7, 26, 0, 0, 0, 0).getTime() - 1
  const nextDay = new Date(2026, 7, 27, 0, 0, 0, 0).getTime()

  it('等于匹配当天本地日期', () => {
    expect(matchTimestampByDateFilter(midday, 'eq', '2026-08-26')).toBe(true)
    expect(matchTimestampByDateFilter(before, 'eq', '2026-08-26')).toBe(false)
    expect(matchTimestampByDateFilter(nextDay, 'eq', '2026-08-26')).toBe(false)
  })

  it('大于等于从当天 00:00 起算', () => {
    expect(matchTimestampByDateFilter(midday, 'gte', '2026-08-26')).toBe(true)
    expect(matchTimestampByDateFilter(before, 'gte', '2026-08-26')).toBe(false)
  })

  it('小于等于到当天结束', () => {
    expect(matchTimestampByDateFilter(midday, 'lte', '2026-08-26')).toBe(true)
    expect(matchTimestampByDateFilter(nextDay, 'lte', '2026-08-26')).toBe(false)
  })

  it('拒绝无效日期', () => {
    expect(normalizeFilterDate('2026-02-31')).toBeUndefined()
    expect(matchTimestampByDateFilter(midday, 'eq', '2026-02-31')).toBe(false)
  })

  it('兼容仅日期字符串，按本地整天匹配', () => {
    expect(normalizeFilterDate('2026-08-26')).toBe('2026-08-26')
  })

  it('规范化带时分秒的筛选值', () => {
    expect(normalizeFilterDate('2026-08-26 09:08:07')).toBe('2026-08-26 09:08:07')
    expect(normalizeFilterDate('2026-08-26T09:08:07')).toBe('2026-08-26 09:08:07')
    expect(normalizeFilterDate('2026-08-26 25:00:00')).toBeUndefined()
  })

  it('等于匹配到所选秒', () => {
    const exact = new Date(2026, 7, 26, 12, 30, 45, 200).getTime()
    const nextSecond = new Date(2026, 7, 26, 12, 30, 46, 0).getTime()
    expect(matchTimestampByDateFilter(exact, 'eq', '2026-08-26 12:30:45')).toBe(true)
    expect(matchTimestampByDateFilter(nextSecond, 'eq', '2026-08-26 12:30:45')).toBe(false)
  })

  it('大于等于从所选秒起点算', () => {
    const start = new Date(2026, 7, 26, 12, 30, 45, 0).getTime()
    const before = start - 1
    expect(matchTimestampByDateFilter(start, 'gte', '2026-08-26 12:30:45')).toBe(true)
    expect(matchTimestampByDateFilter(before, 'gte', '2026-08-26 12:30:45')).toBe(false)
  })

  it('小于等于包含所选整秒', () => {
    const end = new Date(2026, 7, 26, 12, 30, 45, 999).getTime()
    const after = end + 1
    expect(matchTimestampByDateFilter(end, 'lte', '2026-08-26 12:30:45')).toBe(true)
    expect(matchTimestampByDateFilter(after, 'lte', '2026-08-26 12:30:45')).toBe(false)
  })

  it('介于两个时间之间（含两端，起止颠倒也会对齐）', () => {
    const inside = new Date(2026, 7, 26, 12, 0, 0, 0).getTime()
    const start = new Date(2026, 7, 26, 10, 0, 0, 0).getTime()
    const end = new Date(2026, 7, 26, 18, 0, 0, 999).getTime()
    const before = start - 1
    const after = end + 1
    expect(
      matchTimestampByDateFilter(inside, 'between', '2026-08-26 10:00:00', '2026-08-26 18:00:00')
    ).toBe(true)
    expect(
      matchTimestampByDateFilter(start, 'between', '2026-08-26 18:00:00', '2026-08-26 10:00:00')
    ).toBe(true)
    expect(
      matchTimestampByDateFilter(before, 'between', '2026-08-26 10:00:00', '2026-08-26 18:00:00')
    ).toBe(false)
    expect(
      matchTimestampByDateFilter(after, 'between', '2026-08-26 10:00:00', '2026-08-26 18:00:00')
    ).toBe(false)
  })

  it('介于只有起点时视为大于等于', () => {
    expect(matchTimestampByDateFilter(midday, 'between', '2026-08-26 10:00:00')).toBe(true)
    expect(matchTimestampByDateFilter(before, 'between', '2026-08-26 12:00:00')).toBe(false)
  })

  it('介于只有终点时视为小于等于', () => {
    expect(matchTimestampByDateFilter(midday, 'between', '', '2026-08-26 18:00:00')).toBe(true)
    expect(matchTimestampByDateFilter(nextDay, 'between', undefined, '2026-08-26 12:00:00')).toBe(
      false
    )
  })

  it('范围两端颠倒时按时间先后重排', () => {
    expect(orderFilterDateRange('2026-08-26 18:00:00', '2026-08-26 10:00:00')).toEqual({
      from: '2026-08-26 10:00:00',
      to: '2026-08-26 18:00:00'
    })
  })

  it('允许只填起点或终点', () => {
    expect(resolveFilterDateBounds('2026-08-26 10:00:00', '')).toEqual({
      from: '2026-08-26 10:00:00'
    })
    expect(resolveFilterDateBounds('', '2026-08-26 18:00:00')).toEqual({
      to: '2026-08-26 18:00:00'
    })
  })
})
