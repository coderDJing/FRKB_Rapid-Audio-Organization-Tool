import { describe, expect, it } from 'vitest'
import { rebaseHorizontalBrowsePlaybackClock } from './horizontalBrowseLivePlaybackClock'

describe('horizontalBrowseLivePlaybackClock', () => {
  it('倍率不变时不改基准', () => {
    expect(rebaseHorizontalBrowsePlaybackClock(10, 1000, 1, 1, 1500)).toEqual({
      baseSec: 10,
      baseAtMs: 1000,
      playbackRate: 1
    })
  })

  it('倍率变化时从当前估计位置重锚，避免跳回旧 snapshot', () => {
    const next = rebaseHorizontalBrowsePlaybackClock(10, 1000, 1, 1.25, 2000)
    expect(next.baseSec).toBeCloseTo(11, 6)
    expect(next.baseAtMs).toBe(2000)
    expect(next.playbackRate).toBe(1.25)
  })
})
