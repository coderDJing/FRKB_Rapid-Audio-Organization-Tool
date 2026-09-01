import { describe, expect, it } from 'vitest'
import {
  HIDDEN_MINI_PLAYER_TASK_PROGRESS,
  cloneMiniPlayerTaskProgress,
  resolveMiniPlayerTaskProgress,
  resolveTaskProgressPercent
} from './miniPlayerTaskProgress'

describe('resolveTaskProgressPercent', () => {
  it('returns null for indeterminate tasks', () => {
    expect(resolveTaskProgressPercent({ noProgress: true, now: 1, total: 4 })).toBeNull()
  })

  it('returns 0 when total is not positive', () => {
    expect(resolveTaskProgressPercent({ now: 3, total: 0 })).toBe(0)
  })

  it('rounds determinate percent into 0-100', () => {
    expect(resolveTaskProgressPercent({ now: 1, total: 3 })).toBe(33)
    expect(resolveTaskProgressPercent({ now: 3, total: 3 })).toBe(100)
  })
})

describe('resolveMiniPlayerTaskProgress', () => {
  it('hides when nothing is visible', () => {
    expect(
      resolveMiniPlayerTaskProgress([
        { visible: false, percent: 40 },
        { visible: false, percent: null }
      ])
    ).toEqual(HIDDEN_MINI_PLAYER_TASK_PROGRESS)
  })

  it('uses the lowest determinate percent as the bottleneck', () => {
    expect(
      resolveMiniPlayerTaskProgress([
        { visible: true, percent: 80 },
        { visible: true, percent: 12 },
        { visible: false, percent: 1 }
      ])
    ).toEqual({ visible: true, percent: 12 })
  })

  it('falls back to indeterminate when visible tasks have no percent', () => {
    expect(
      resolveMiniPlayerTaskProgress([
        { visible: true, percent: null },
        { visible: false, percent: 90 }
      ])
    ).toEqual({ visible: true, percent: null })
  })

  it('ignores indeterminate siblings when a determinate percent exists', () => {
    expect(
      resolveMiniPlayerTaskProgress([
        { visible: true, percent: null },
        { visible: true, percent: 64 }
      ])
    ).toEqual({ visible: true, percent: 64 })
  })
})

describe('cloneMiniPlayerTaskProgress', () => {
  it('hides invalid payloads', () => {
    expect(cloneMiniPlayerTaskProgress(null)).toEqual(HIDDEN_MINI_PLAYER_TASK_PROGRESS)
    expect(cloneMiniPlayerTaskProgress({ visible: false, percent: 40 })).toEqual(
      HIDDEN_MINI_PLAYER_TASK_PROGRESS
    )
  })

  it('keeps indeterminate visible progress', () => {
    expect(cloneMiniPlayerTaskProgress({ visible: true, percent: null })).toEqual({
      visible: true,
      percent: null
    })
  })
})
