import { describe, expect, it } from 'vitest'
import {
  hasForegroundSongCacheRead,
  trackForegroundSongCacheRead,
  waitForForegroundSongCacheRead
} from './foregroundSongCacheRead'

describe('foregroundSongCacheRead', () => {
  it('读取结束或失败后立刻放开，不等后台修复', async () => {
    expect(hasForegroundSongCacheRead()).toBe(false)
    let release!: () => void
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('ok')
    })
    const tracked = trackForegroundSongCacheRead(() => pending)
    expect(hasForegroundSongCacheRead()).toBe(true)
    release()
    await expect(tracked).resolves.toBe('ok')
    expect(hasForegroundSongCacheRead()).toBe(false)

    await expect(
      trackForegroundSongCacheRead(() => Promise.reject(new Error('fail')))
    ).rejects.toThrow('fail')
    expect(hasForegroundSongCacheRead()).toBe(false)
  })

  it('整段预算用完就返回，不会按页重新等待', async () => {
    let release!: () => void
    const tracked = trackForegroundSongCacheRead(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const started = Date.now()
    await waitForForegroundSongCacheRead(started + 80)
    expect(Date.now() - started).toBeLessThan(500)
    expect(hasForegroundSongCacheRead()).toBe(true)
    release()
    await tracked
    expect(hasForegroundSongCacheRead()).toBe(false)
  })

  it('读取先结束时不会把预算耗尽', async () => {
    const tracked = trackForegroundSongCacheRead(
      () => new Promise<void>((resolve) => setTimeout(resolve, 60))
    )
    const started = Date.now()
    await waitForForegroundSongCacheRead(started + 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
    await tracked
  })
})
