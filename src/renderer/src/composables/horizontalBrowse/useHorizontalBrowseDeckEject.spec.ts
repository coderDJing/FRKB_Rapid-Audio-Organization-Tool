import { describe, expect, it, vi } from 'vitest'
import type { HorizontalBrowseDeckKey } from '@shared/horizontalBrowseTransport'
import { resolveHorizontalBrowseDeckSyncUiEnabled } from './horizontalBrowseShellState'
import { createHorizontalBrowseDeckEjectHandler } from './useHorizontalBrowseDeckEject'

const setup = (syncEnabled: boolean, cuePreviewActive = false) => {
  const snapshots = { top: { syncEnabled }, bottom: { syncEnabled } }
  const cuePreview = {
    active: cuePreviewActive,
    pointerId: cuePreviewActive ? 1 : null,
    cueSeconds: 12,
    syncEnabledBefore: cuePreviewActive,
    syncLockBefore: cuePreviewActive ? 'full' : 'off',
    token: 1
  }
  const suppressDeckCueClick = { top: true, bottom: true }
  const setSyncEnabled = vi.fn(async (deck: HorizontalBrowseDeckKey, enabled: boolean) => {
    snapshots[deck].syncEnabled = enabled
  })
  const setDeckSong = vi.fn()
  const commitDeckStateToNative = vi.fn(async () => undefined)
  const eject = createHorizontalBrowseDeckEjectHandler({
    resolveDeckCuePreviewRuntimeState: () => cuePreview,
    resolveTransportDeckSnapshot: (deck) => snapshots[deck],
    nativeTransport: { setSyncEnabled },
    setDeckSong,
    commitDeckStateToNative,
    suppressDeckCueClick
  })
  return {
    snapshots,
    cuePreview,
    suppressDeckCueClick,
    setSyncEnabled,
    setDeckSong,
    commitDeckStateToNative,
    eject
  }
}

describe('deck eject Beat Sync retention', () => {
  it.each(['top', 'bottom'] as const)(
    'keeps %s Beat Sync enabled while unloading',
    async (deck) => {
      const context = setup(true)
      await context.eject(deck)

      expect(context.setDeckSong).toHaveBeenCalledWith(deck, null)
      expect(context.commitDeckStateToNative).toHaveBeenCalledWith(deck, {
        currentSec: 0,
        lastObservedAtMs: expect.any(Number),
        durationSec: 0,
        playing: false,
        playbackRate: 1
      })
      expect(context.setSyncEnabled).not.toHaveBeenCalled()
      expect(context.snapshots.top.syncEnabled).toBe(true)
      expect(context.snapshots.bottom.syncEnabled).toBe(true)
      expect(resolveHorizontalBrowseDeckSyncUiEnabled(false, true, false, false)).toBe(true)
    }
  )

  it('keeps disabled Beat Sync disabled', async () => {
    const context = setup(false)
    await context.eject('bottom')

    expect(context.setSyncEnabled).not.toHaveBeenCalled()
    expect(context.snapshots.bottom.syncEnabled).toBe(false)
    expect(resolveHorizontalBrowseDeckSyncUiEnabled(false, false, false, false)).toBe(false)
  })

  it('restores temporarily suspended sync after unloading a CUE preview', async () => {
    const context = setup(false, true)
    await context.eject('bottom')

    expect(context.cuePreview).toEqual({
      active: false,
      pointerId: null,
      cueSeconds: 0,
      syncEnabledBefore: false,
      syncLockBefore: 'off',
      token: 2
    })
    expect(context.suppressDeckCueClick.bottom).toBe(false)
    expect(context.setSyncEnabled).toHaveBeenCalledExactlyOnceWith('bottom', true)
    expect(context.commitDeckStateToNative.mock.invocationCallOrder[0]).toBeLessThan(
      context.setSyncEnabled.mock.invocationCallOrder[0]
    )
    expect(context.snapshots.bottom.syncEnabled).toBe(true)
    expect(context.snapshots.top.syncEnabled).toBe(false)
  })
})
