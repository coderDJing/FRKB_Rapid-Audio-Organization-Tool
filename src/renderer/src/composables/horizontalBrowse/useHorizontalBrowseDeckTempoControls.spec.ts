import { describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { useHorizontalBrowseDeckTempoControls } from './useHorizontalBrowseDeckTempoControls'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return {
    ...actual,
    onUnmounted: vi.fn()
  }
})

const createSong = (filePath: string, bpm: number): ISongInfo => ({
  filePath,
  fileName: filePath,
  fileFormat: 'mp3',
  cover: null,
  title: filePath,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  bpm
})

describe('useHorizontalBrowseDeckTempoControls', () => {
  it('BeatSync 中拖动从轨 BPM 保持同步并把速度命令发给主轨', async () => {
    const songs = {
      top: createSong('top.mp3', 120),
      bottom: createSong('bottom.mp3', 136)
    }
    const snapshots = {
      top: {
        playbackRate: 1,
        effectiveBpm: 120,
        syncEnabled: true,
        syncLock: 'full',
        leader: true
      },
      bottom: {
        playbackRate: 120 / 136,
        effectiveBpm: 120,
        syncEnabled: true,
        syncLock: 'full',
        leader: false
      }
    }
    const nativeTransport = {
      setSyncEnabled: vi.fn(async () => undefined),
      setPlaybackRate: vi.fn(async () => undefined),
      setPlaybackRateLive: vi.fn(),
      setLiveClockPlaybackRate: vi.fn()
    }
    const onLiveVisualPlaybackRate = vi.fn()
    const controls = useHorizontalBrowseDeckTempoControls({
      resolveDeckSong: (deck) => songs[deck],
      resolveDeckGridBpm: (deck) => songs[deck].bpm || 0,
      resolveTransportDeckSnapshot: (deck) => snapshots[deck],
      nativeTransport,
      onLiveVisualPlaybackRate
    })

    controls.scheduleDeckLiveTargetBpm('bottom', 132)

    expect(nativeTransport.setSyncEnabled).not.toHaveBeenCalled()
    expect(nativeTransport.setPlaybackRateLive).toHaveBeenCalledWith('top', 1.1)
    expect(nativeTransport.setLiveClockPlaybackRate).toHaveBeenCalledWith('top', 1.1)
    expect(nativeTransport.setLiveClockPlaybackRate).toHaveBeenCalledWith(
      'bottom',
      expect.closeTo(132 / 136, 8)
    )

    await controls.commitDeckTargetBpm('bottom', 132)

    expect(nativeTransport.setSyncEnabled).not.toHaveBeenCalled()
    expect(nativeTransport.setPlaybackRate).toHaveBeenCalledWith('top', 1.1)
    expect(onLiveVisualPlaybackRate).toHaveBeenCalledWith('top', null)
    expect(onLiveVisualPlaybackRate).toHaveBeenCalledWith('bottom', null)
  })
})
