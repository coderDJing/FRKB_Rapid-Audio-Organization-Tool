import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec,
  resolveHorizontalBrowsePlaybackAlignedStart
} from './horizontalBrowseDetailMath'

describe('horizontal browse detail grid snapping', () => {
  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: 120,
    firstBeatMs: 100,
    downbeatBeatOffset: 2,
    source: 'analysis'
  })
  if (!beatGridMap) throw new Error('failed to create test v2 beat grid map')

  it('snaps cue points to the canonical v2 runtime line', () => {
    expect(resolveHorizontalBrowseCuePointSec({ beatGridMap }, 0.58, 10)).toBe(0.6)
  })

  it('does not rebuild a grid from projections when the v2 map is missing', () => {
    expect(resolveHorizontalBrowseCuePointSec(null, 0.58, 10)).toBe(0)
    expect(resolveHorizontalBrowseDefaultCuePointSec(null, 10)).toBe(0)
  })

  it('uses the first canonical runtime line as the default cue point', () => {
    expect(resolveHorizontalBrowseDefaultCuePointSec({ beatGridMap }, 10)).toBe(0.1)
  })
})

describe('resolveHorizontalBrowsePlaybackAlignedStart 播放头对齐随 visibleDuration 变化', () => {
  // tempo 松手横跳的根因是：stable canvas 用“当前 rate 的 visibleDuration”对齐旧密度帧，
  // 屏幕 50% 偏离真实播放头。修复要求对齐必须按传入的 visibleDuration（= 帧自身密度一屏时长）计算。
  // 该用例锁住“visibleDuration 会真正改变屏幕左缘”这一契约，防止上层 wiring 再把 override 吞掉。
  it('屏幕左缘 = seconds − visibleDuration × 0.5（allowNegativeTimeline）', () => {
    const seconds = 2.1738
    const oldVisible = 12
    const newVisible = 10.5419
    const startOld = resolveHorizontalBrowsePlaybackAlignedStart(seconds, 600, oldVisible, true)
    const startNew = resolveHorizontalBrowsePlaybackAlignedStart(seconds, 600, newVisible, true)
    expect(startOld).toBeCloseTo(seconds - oldVisible * 0.5, 6)
    expect(startNew).toBeCloseTo(seconds - newVisible * 0.5, 6)
    // 两个 visibleDuration 必须给出不同起点（差值 = 半个 visibleDuration 差），否则说明 override 失效。
    expect(Math.abs(startOld - startNew)).toBeCloseTo((oldVisible - newVisible) * 0.5, 6)
  })
})
