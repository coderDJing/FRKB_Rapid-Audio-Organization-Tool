/** 自研日期时间选择器的日历网格与时间列滚动计算 */
export const MIN_PICKER_YEAR = 1970
export const MAX_PICKER_YEAR = 2100
export const YEAR_PAGE_SIZE = 12
export const TIME_ITEM_HEIGHT = 28

export type CalendarCell = {
  year: number
  month: number
  day: number
  outside: boolean
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

export function shiftYearMonth(
  year: number,
  month: number,
  deltaMonth: number
): { year: number; month: number } {
  const date = new Date(year, month - 1 + deltaMonth, 1)
  let nextYear = date.getFullYear()
  let nextMonth = date.getMonth() + 1
  if (nextYear < MIN_PICKER_YEAR) {
    nextYear = MIN_PICKER_YEAR
    nextMonth = 1
  }
  if (nextYear > MAX_PICKER_YEAR) {
    nextYear = MAX_PICKER_YEAR
    nextMonth = 12
  }
  return { year: nextYear, month: nextMonth }
}

export function buildCalendarCells(year: number, month: number): CalendarCell[] {
  const firstWeekday = new Date(year, month - 1, 1).getDay()
  const thisDays = daysInMonth(year, month)
  const prev = shiftYearMonth(year, month, -1)
  const next = shiftYearMonth(year, month, 1)
  const prevDays = daysInMonth(prev.year, prev.month)
  const cells: CalendarCell[] = []
  for (let index = 0; index < 42; index++) {
    const dayNum = index - firstWeekday + 1
    if (dayNum < 1) {
      cells.push({
        year: prev.year,
        month: prev.month,
        day: prevDays + dayNum,
        outside: true
      })
    } else if (dayNum > thisDays) {
      cells.push({
        year: next.year,
        month: next.month,
        day: dayNum - thisDays,
        outside: true
      })
    } else {
      cells.push({ year, month, day: dayNum, outside: false })
    }
  }
  return cells
}

export function buildYearPage(anchorYear: number): number[] {
  const bounded = Math.min(MAX_PICKER_YEAR, Math.max(MIN_PICKER_YEAR, anchorYear))
  const start =
    MIN_PICKER_YEAR + Math.floor((bounded - MIN_PICKER_YEAR) / YEAR_PAGE_SIZE) * YEAR_PAGE_SIZE
  return Array.from({ length: YEAR_PAGE_SIZE }, (_, index) => start + index).filter(
    (year) => year <= MAX_PICKER_YEAR
  )
}

export function scrollTimeListToValue(el: HTMLElement | null, value: number): void {
  if (!el) return
  const top = value * TIME_ITEM_HEIGHT - (el.clientHeight - TIME_ITEM_HEIGHT) / 2
  el.scrollTop = Math.max(0, top)
}
