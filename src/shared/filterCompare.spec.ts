import { describe, expect, it } from 'vitest'
import { matchComparableByFilter } from './filterCompare'

describe('matchComparableByFilter', () => {
  it('等于、大于等于、小于等于', () => {
    expect(matchComparableByFilter(128, 'eq', 128)).toBe(true)
    expect(matchComparableByFilter(128, 'eq', 129)).toBe(false)
    expect(matchComparableByFilter(128, 'gte', 120)).toBe(true)
    expect(matchComparableByFilter(119, 'gte', 120)).toBe(false)
    expect(matchComparableByFilter(90, 'lte', 100)).toBe(true)
    expect(matchComparableByFilter(101, 'lte', 100)).toBe(false)
  })

  it('介于两端包含，起止颠倒也对', () => {
    expect(matchComparableByFilter(128, 'between', 120, 130)).toBe(true)
    expect(matchComparableByFilter(120, 'between', 130, 120)).toBe(true)
    expect(matchComparableByFilter(119, 'between', 120, 130)).toBe(false)
    expect(matchComparableByFilter(131, 'between', 120, 130)).toBe(false)
  })

  it('介于只有起点时视为大于等于', () => {
    expect(matchComparableByFilter(128, 'between', 120)).toBe(true)
    expect(matchComparableByFilter(119, 'between', 120)).toBe(false)
  })

  it('介于只有终点时视为小于等于', () => {
    expect(matchComparableByFilter(90, 'between', null, 100)).toBe(true)
    expect(matchComparableByFilter(101, 'between', undefined, 100)).toBe(false)
  })
})
