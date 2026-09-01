import { describe, expect, it } from 'vitest'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { canCommitHorizontalBrowseBlankRawSegment } from './horizontalBrowseRawWaveformCoverage'

const createRawData = (loadedFrames: number): RawWaveformData => {
  const frames = 1000
  return {
    duration: 10,
    sampleRate: 48000,
    rate: 100,
    frames,
    startSec: 0,
    loadedFrames,
    minLeft: new Float32Array(frames),
    maxLeft: new Float32Array(frames),
    minRight: new Float32Array(frames),
    maxRight: new Float32Array(frames)
  }
}

describe('canCommitHorizontalBrowseBlankRawSegment', () => {
  it('允许把歌曲起点前的负时间瓦片作为合法空白提交', () => {
    expect(canCommitHorizontalBrowseBlankRawSegment(createRawData(1000), -2, 2, 0)).toBe(true)
  })

  it('允许把歌曲结束后的瓦片作为合法空白提交', () => {
    expect(canCommitHorizontalBrowseBlankRawSegment(createRawData(1000), 10, 2, 0)).toBe(true)
  })

  it('允许已加载范围内没有像素的静音瓦片提交', () => {
    expect(canCommitHorizontalBrowseBlankRawSegment(createRawData(1000), 1, 0.5, 0)).toBe(true)
  })

  it('拒绝把歌曲内部尚未加载的区间提前标记为完成', () => {
    expect(canCommitHorizontalBrowseBlankRawSegment(createRawData(200), 3, 1, 0)).toBe(false)
  })
})
