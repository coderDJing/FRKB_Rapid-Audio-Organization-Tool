import { describe, expect, it } from 'vitest'
import type { AudioEditClip } from '@shared/audioEditTimeline'
import { resolveHorizontalBrowseAudioEditScrubPreview } from './horizontalBrowseAudioEditScrub'

const clips: AudioEditClip[] = [
  { id: 'intro', sourceStartSec: 0, sourceEndSec: 10 },
  { id: 'copy', sourceStartSec: 30, sourceEndSec: 35 },
  { id: 'outro', sourceStartSec: 10, sourceEndSec: 20 }
]

describe('resolveHorizontalBrowseAudioEditScrubPreview', () => {
  it('maps edited timeline positions back to the source song', () => {
    expect(
      resolveHorizontalBrowseAudioEditScrubPreview(clips, {
        anchorSec: 12,
        playbackRate: -0.8
      })
    ).toEqual({
      anchorSec: 32,
      playbackRate: -0.8
    })
  })

  it('enters the next source clip at an edit boundary', () => {
    expect(
      resolveHorizontalBrowseAudioEditScrubPreview(clips, {
        anchorSec: 15,
        playbackRate: 1
      })
    ).toEqual({
      anchorSec: 10,
      playbackRate: 1
    })
  })
})
