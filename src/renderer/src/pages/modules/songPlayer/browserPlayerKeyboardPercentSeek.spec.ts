import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createBrowserPlayerKeyboardPercentSeek } from './browserPlayerKeyboardPercentSeek'

describe('createBrowserPlayerKeyboardPercentSeek', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const createApi = (seek = vi.fn()) => {
    const api = createBrowserPlayerKeyboardPercentSeek({
      getPlayer: () => ({
        getDuration: () => 100,
        seek
      }),
      getFilePath: () => '/a.mp3',
      isAllowed: () => true
    })
    return { api, seek }
  }

  it('immediate 跳过防抖立刻 seek', () => {
    const { api, seek } = createApi()
    api.request(0.3, { immediate: true })
    expect(seek).toHaveBeenCalledWith(30, true)
  })

  it('默认仍走 80ms 防抖', () => {
    const { api, seek } = createApi()
    api.request(0.5)
    expect(seek).not.toHaveBeenCalled()
    vi.advanceTimersByTime(79)
    expect(seek).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(seek).toHaveBeenCalledWith(50, true)
  })
})
