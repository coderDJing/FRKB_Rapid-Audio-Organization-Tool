import { describe, expect, it } from 'vitest'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { remapAudioEditRawWaveform } from './audioEditCompactWaveform'
import type { AudioEditClip } from '@shared/audioEditTimeline'

const clip = (id: string, start: number, end: number): AudioEditClip => ({
  id,
  sourceStartSec: start,
  sourceEndSec: end
})

const createRampRaw = (durationSec: number, rate: number): RawWaveformData => {
  const frames = Math.round(durationSec * rate)
  const maxLeft = new Float32Array(frames)
  const minLeft = new Float32Array(frames)
  const maxRight = new Float32Array(frames)
  const minRight = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    maxLeft[index] = index
    minLeft[index] = -index
    maxRight[index] = index
    minRight[index] = -index
  }
  return {
    duration: durationSec,
    sampleRate: 44100,
    rate,
    frames,
    startSec: 0,
    loadedFrames: frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight
  }
}

describe('remapAudioEditRawWaveform', () => {
  it('keeps identity clips on the original buffer', () => {
    const source = createRampRaw(10, 10)
    const remapped = remapAudioEditRawWaveform(source, [clip('a', 0, 10)])
    expect(remapped).toBe(source)
  })

  it('drops the cut source range and keeps the zoomed plan duration', () => {
    const source = createRampRaw(10, 10)
    const remapped = remapAudioEditRawWaveform(source, [clip('a', 0, 2), clip('b', 4, 10)])
    expect(remapped).not.toBe(source)
    expect(remapped?.duration).toBe(8)
    expect(remapped?.frames).toBe(80)
    expect(remapped?.maxLeft[19]).toBe(19)
    expect(remapped?.maxLeft[20]).toBe(40)
    expect(remapped?.maxLeft[79]).toBe(99)
  })

  it('duplicates looped source audio on the plan timeline', () => {
    const source = createRampRaw(4, 10)
    const remapped = remapAudioEditRawWaveform(source, [
      clip('a', 0, 4),
      clip('b', 1, 2),
      clip('c', 1, 2)
    ])
    expect(remapped?.duration).toBe(6)
    expect(remapped?.maxLeft[40]).toBe(10)
    expect(remapped?.maxLeft[50]).toBe(10)
  })
})
