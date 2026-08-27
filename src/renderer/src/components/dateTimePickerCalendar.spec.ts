import { describe, expect, it } from 'vitest'
import {
  MAX_PICKER_YEAR,
  MIN_PICKER_YEAR,
  buildCalendarCells,
  buildYearPage,
  daysInMonth,
  shiftYearMonth
} from './dateTimePickerCalendar'

describe('dateTimePickerCalendar', () => {
  it('闰年二月有 29 天', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
  })

  it('从一月往前翻到上一年十二月', () => {
    expect(shiftYearMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
  })

  it('年份不越出可选范围', () => {
    expect(shiftYearMonth(MIN_PICKER_YEAR, 1, -1)).toEqual({
      year: MIN_PICKER_YEAR,
      month: 1
    })
    expect(shiftYearMonth(MAX_PICKER_YEAR, 12, 1)).toEqual({
      year: MAX_PICKER_YEAR,
      month: 12
    })
  })

  it('日历网格固定 42 格且包含上个月尾部', () => {
    const cells = buildCalendarCells(2026, 8)
    expect(cells).toHaveLength(42)
    expect(cells[0]).toEqual({ year: 2026, month: 7, day: 26, outside: true })
    expect(cells[6]).toEqual({ year: 2026, month: 8, day: 1, outside: false })
  })

  it('年份面板按 12 年分页', () => {
    expect(buildYearPage(2026)[0]).toBe(2018)
    expect(buildYearPage(2026)).toHaveLength(12)
  })
})
