import { describe, expect, it } from 'vitest'
import { shouldCommitHorizontalBrowseDragReleaseRenderedViewport } from './horizontalBrowseDragPresentationRelease'

describe('shouldCommitHorizontalBrowseDragReleaseRenderedViewport', () => {
  it('commits ordinary rendered frames when no drag release is pending', () => {
    expect(
      shouldCommitHorizontalBrowseDragReleaseRenderedViewport({
        pending: false,
        canCompleteRelease: false,
        releaseExpired: false
      })
    ).toBe(true)
  })

  it('holds the committed viewport until the release frame matches the drag result', () => {
    expect(
      shouldCommitHorizontalBrowseDragReleaseRenderedViewport({
        pending: true,
        canCompleteRelease: false,
        releaseExpired: false
      })
    ).toBe(false)
  })

  it('commits once the rendered viewport matches the drag result', () => {
    expect(
      shouldCommitHorizontalBrowseDragReleaseRenderedViewport({
        pending: true,
        canCompleteRelease: true,
        releaseExpired: false
      })
    ).toBe(true)
  })
})
