import { describe, expect, it } from 'vitest'
import { shouldNotifyHorizontalBrowseAlignedDragReleaseSeek } from './horizontalBrowseDragReleaseSeekIntent'

describe('shouldNotifyHorizontalBrowseAlignedDragReleaseSeek', () => {
  it('合并同一次松手中仅有微小误差的第二次 seek intent', () => {
    expect(shouldNotifyHorizontalBrowseAlignedDragReleaseSeek(18.817, 18.819)).toBe(false)
    expect(shouldNotifyHorizontalBrowseAlignedDragReleaseSeek(18.817, 18.851)).toBe(false)
  })

  it('native 实际落点明显偏离时保留二次校正', () => {
    expect(shouldNotifyHorizontalBrowseAlignedDragReleaseSeek(18.817, 18.853)).toBe(true)
  })

  it('无法比较的输入不阻断后续校正', () => {
    expect(shouldNotifyHorizontalBrowseAlignedDragReleaseSeek(Number.NaN, 10)).toBe(true)
  })
})
