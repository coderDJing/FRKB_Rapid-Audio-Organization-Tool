import { describe, expect, it } from 'vitest'
import {
  clampDeckPlaybackRate,
  resolveDeckTargetPlaybackRate,
  shouldApplyDeckTargetBpm
} from './horizontalBrowseDeckTempo'

describe('horizontalBrowseDeckTempo', () => {
  it('把目标 BPM 换成播放倍率，并夹紧到引擎范围', () => {
    expect(resolveDeckTargetPlaybackRate(128, 128)).toBeCloseTo(1, 6)
    expect(resolveDeckTargetPlaybackRate(129.28, 128)).toBeCloseTo(1.01, 6)
    expect(resolveDeckTargetPlaybackRate(300, 60)).toBe(4)
    expect(resolveDeckTargetPlaybackRate(10, 128)).toBe(0.25)
    expect(resolveDeckTargetPlaybackRate(0, 128)).toBeNull()
    expect(resolveDeckTargetPlaybackRate(128, 0)).toBeNull()
  })

  it('0.01 BPM 步进必须提交，不能被旧的倍率误差门槛吃掉', () => {
    expect(shouldApplyDeckTargetBpm(128, 128.01)).toBe(true)
    expect(shouldApplyDeckTargetBpm(174, 174.01)).toBe(true)
    expect(shouldApplyDeckTargetBpm(128, 128)).toBe(false)
    expect(shouldApplyDeckTargetBpm(0, 128)).toBe(true)
  })

  it('播放倍率夹紧范围与引擎一致', () => {
    expect(clampDeckPlaybackRate(0.1)).toBe(0.25)
    expect(clampDeckPlaybackRate(8)).toBe(4)
    expect(clampDeckPlaybackRate(1.25)).toBe(1.25)
  })
})
