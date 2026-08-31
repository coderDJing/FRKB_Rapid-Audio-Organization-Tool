import { describe, expect, it, vi } from 'vitest'
import { isProxy, nextTick, ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { useHorizontalBrowseAudioEditDetailRaw } from './useHorizontalBrowseAudioEditDetailRaw'
import type { AudioEditClip } from '@shared/audioEditTimeline'

const clip = (id: string, start: number, end: number): AudioEditClip => ({
  id,
  sourceStartSec: start,
  sourceEndSec: end
})

const createRampRaw = (durationSec: number, rate: number): RawWaveformData => {
  const frames = Math.round(durationSec * rate)
  return {
    duration: durationSec,
    sampleRate: 44100,
    rate,
    frames,
    startSec: 0,
    loadedFrames: frames,
    minLeft: new Float32Array(frames),
    maxLeft: new Float32Array(frames),
    minRight: new Float32Array(frames),
    maxRight: new Float32Array(frames)
  }
}

describe('useHorizontalBrowseAudioEditDetailRaw', () => {
  it('sends a cloneable raw object to the canvas worker for an identity edit', () => {
    const source = createRampRaw(10, 10)
    const sourceRawData = ref<RawWaveformData | null>(null)
    const replaceLiveWaveformRaw = vi.fn()
    const { commitSource } = useHorizontalBrowseAudioEditDetailRaw({
      clips: () => [clip('identity', 0, 10)],
      sourceRawData,
      displayRawData: ref<RawWaveformData | null>(null),
      mixxxData: ref<MixxxWaveformData | null>(null),
      replaceLiveWaveformRaw,
      resetPlaybackRenderState: vi.fn(),
      reanchorViewport: vi.fn(),
      scheduleDraw: vi.fn()
    })

    commitSource(source)

    const posted = replaceLiveWaveformRaw.mock.lastCall?.[0]
    expect(posted).toBe(source)
    expect(isProxy(posted)).toBe(false)
  })

  it('keeps the current waveform visible when paste changes the plan duration', async () => {
    const source = createRampRaw(10, 10)
    const clips = ref([clip('a', 0, 10)])
    const sourceRawData = ref<RawWaveformData | null>(source)
    const displayRawData = ref<RawWaveformData | null>(source)
    const mixxxData = ref<MixxxWaveformData | null>(null)
    const resetPlaybackRenderState = vi.fn()
    const reanchorViewport = vi.fn()
    const scheduleDraw = vi.fn()
    useHorizontalBrowseAudioEditDetailRaw({
      clips: () => clips.value,
      sourceRawData,
      displayRawData,
      mixxxData,
      replaceLiveWaveformRaw: vi.fn(),
      resetPlaybackRenderState,
      reanchorViewport,
      scheduleDraw
    })

    clips.value = [clip('a', 0, 10), clip('b', 2, 4)]
    await nextTick()

    expect(resetPlaybackRenderState).toHaveBeenCalledWith({ preserveDisplay: true })
    expect(resetPlaybackRenderState).not.toHaveBeenCalledWith({ preserveDisplay: false })
    expect(reanchorViewport).toHaveBeenCalledOnce()
    expect(scheduleDraw).toHaveBeenCalledWith({ preferPreviewStart: true })
  })
})
