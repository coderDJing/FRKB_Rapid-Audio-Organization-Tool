import { describe, expect, it } from 'vitest'
import {
  resolveAudioEditOverlayViewport,
  resolveAudioEditViewportBoundStyle,
  resolveAudioEditViewportSelectionStyle
} from './audioEditDetailSelectionOverlay'

describe('audioEditDetailSelectionOverlay', () => {
  it('clips a selection that only partly overlaps the viewport', () => {
    expect(resolveAudioEditViewportSelectionStyle({ startSec: 4, endSec: 12 }, 8, 8)).toEqual({
      left: '0%',
      width: '50%'
    })
  })

  it('hides a selection that sits entirely outside the viewport', () => {
    expect(resolveAudioEditViewportSelectionStyle({ startSec: 0, endSec: 2 }, 8, 8)).toBeNull()
  })

  it('places a bound line inside the current viewport', () => {
    expect(resolveAudioEditViewportBoundStyle(10, 8, 8)).toEqual({ left: '25%' })
    expect(resolveAudioEditViewportBoundStyle(0, -4, 8)).toEqual({ left: '50%' })
    expect(resolveAudioEditViewportBoundStyle(2, 8, 8)).toBeNull()
  })

  it('does not treat a missing bound as time zero', () => {
    expect(resolveAudioEditViewportBoundStyle(null, -4, 8)).toBeNull()
    expect(resolveAudioEditViewportBoundStyle(undefined, 0, 8)).toBeNull()
  })

  it('keeps the overlay on the drag preview while the pointer is down', () => {
    expect(
      resolveAudioEditOverlayViewport({
        dragging: true,
        displayViewportStartSec: 4,
        displayViewportDurationSec: 8,
        previewStartSec: 10,
        visibleDurationSec: 8
      })
    ).toEqual({ startSec: 10, durationSec: 8 })
  })

  it('uses the committed canvas viewport after the pointer is released', () => {
    expect(
      resolveAudioEditOverlayViewport({
        dragging: false,
        displayViewportStartSec: 12,
        displayViewportDurationSec: 8,
        previewStartSec: 2,
        visibleDurationSec: 8
      })
    ).toEqual({ startSec: 12, durationSec: 8 })
  })
})
