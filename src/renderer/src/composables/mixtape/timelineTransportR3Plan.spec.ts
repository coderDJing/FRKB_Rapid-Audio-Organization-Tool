import { describe, expect, it } from 'vitest'
import { createTransportPlanBuffer } from './timelineTransportR3Plan'
import type { TransportPlaybackSequence } from './timelineTransportPlaybackSequence'

const createTestBuffer = (channels: number[][], sampleRate = 10) => {
  const channelData = channels.map((channel) => Float32Array.from(channel))
  return {
    numberOfChannels: channelData.length,
    length: channelData[0]?.length || 0,
    sampleRate,
    getChannelData: (channelIndex: number) => channelData[channelIndex]
  } as AudioBuffer
}

const createTestContext = () => ({
  createBuffer(channels: number, frameCount: number, sampleRate: number) {
    return createTestBuffer(
      Array.from({ length: channels }, () => Array.from({ length: frameCount }, () => 0)),
      sampleRate
    )
  }
})

describe('createTransportPlanBuffer', () => {
  it('concatenates playback sequence source ranges in plan order', () => {
    const buffer = createTestBuffer([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    ])
    const sequence: TransportPlaybackSequence = {
      totalPlanSec: 0.6,
      segments: [
        {
          key: 'first',
          localStartSec: 0,
          localEndSec: 0.3,
          baseLocalStartSec: 0.1,
          baseLocalEndSec: 0.4,
          sourceStartSec: 0.1,
          sourceEndSec: 0.4,
          planStartSec: 0,
          planEndSec: 0.3
        },
        {
          key: 'second',
          localStartSec: 0.3,
          localEndSec: 0.6,
          baseLocalStartSec: 0.6,
          baseLocalEndSec: 0.9,
          sourceStartSec: 0.6,
          sourceEndSec: 0.9,
          planStartSec: 0.3,
          planEndSec: 0.6
        }
      ]
    }

    const result = createTransportPlanBuffer(createTestContext(), buffer, sequence)

    expect(result.length).toBe(6)
    expect(Array.from(result.getChannelData(0))).toEqual([1, 2, 3, 6, 7, 8])
    expect(Array.from(result.getChannelData(1))).toEqual([11, 12, 13, 16, 17, 18])
  })

  it('reuses the source buffer when no internal sequence is needed', () => {
    const buffer = createTestBuffer([[0, 1, 2]])
    expect(createTransportPlanBuffer(createTestContext(), buffer)).toBe(buffer)
  })
})
