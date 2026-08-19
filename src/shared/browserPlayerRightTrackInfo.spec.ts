import { describe, expect, it } from 'vitest'
import {
  BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY,
  canTapBrowserPlayerRightTrackInfo,
  normalizeBrowserPlayerRightTrackInfo
} from './browserPlayerRightTrackInfo'

describe('browserPlayerRightTrackInfo', () => {
  it('将未知值归一成默认的 BPM/调性组合项', () => {
    expect(normalizeBrowserPlayerRightTrackInfo(undefined)).toBe(
      BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY
    )
    expect(normalizeBrowserPlayerRightTrackInfo('cover')).toBe(
      BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY
    )
  })

  it('保留已支持的列表字段', () => {
    expect(normalizeBrowserPlayerRightTrackInfo('title')).toBe('title')
    expect(normalizeBrowserPlayerRightTrackInfo('energyScore')).toBe('energyScore')
  })

  it('仅 BPM/调性组合项和单独 BPM 支持点按测速', () => {
    expect(canTapBrowserPlayerRightTrackInfo('bpmKey')).toBe(true)
    expect(canTapBrowserPlayerRightTrackInfo('bpm')).toBe(true)
    expect(canTapBrowserPlayerRightTrackInfo('key')).toBe(false)
    expect(canTapBrowserPlayerRightTrackInfo('title')).toBe(false)
  })
})
