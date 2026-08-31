import { describe, expect, it } from 'vitest'
import { renderAudioEditClipsToInterleavedPcm } from './audioEditPcm'

describe('audio edit pcm render', () => {
  it('does not write past the output buffer when clip edges round up', () => {
    const sampleRate = 44100
    const sourceFrames = sampleRate * 3
    const source = new Float32Array(sourceFrames)
    for (let index = 0; index < sourceFrames; index += 1) {
      source[index] = index / sourceFrames
    }
    const clips = [
      { id: 'a', sourceStartSec: 0, sourceEndSec: 1.3333 },
      { id: 'b', sourceStartSec: 1.3333, sourceEndSec: 2.6667 },
      { id: 'c', sourceStartSec: 2.6667, sourceEndSec: 3 }
    ]
    const rendered = renderAudioEditClipsToInterleavedPcm(
      source,
      sourceFrames,
      1,
      sampleRate,
      clips
    )
    expect(rendered.pcm.length).toBe(rendered.frameCount)
    expect(rendered.frameCount).toBeGreaterThan(sampleRate * 2)
    expect(Number.isFinite(rendered.pcm[rendered.pcm.length - 1])).toBe(true)
  })
})
