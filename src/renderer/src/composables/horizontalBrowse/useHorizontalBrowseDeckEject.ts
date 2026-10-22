import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type UseHorizontalBrowseDeckEjectParams = {
  resolveDeckCuePreviewRuntimeState: (deck: HorizontalBrowseDeckKey) => {
    active: boolean
    pointerId: number | null
    cueSeconds: number
    syncEnabledBefore: boolean
    syncLockBefore: string
    token: number
  }
  resolveTransportDeckSnapshot: (deck: HorizontalBrowseDeckKey) => {
    syncEnabled: boolean
  }
  nativeTransport: {
    setSyncEnabled: (deck: HorizontalBrowseDeckKey, enabled: boolean) => Promise<unknown>
  }
  setDeckSong: (deck: HorizontalBrowseDeckKey, song: null) => void
  commitDeckStateToNative: (
    deck: HorizontalBrowseDeckKey,
    override: {
      currentSec: number
      lastObservedAtMs: number
      durationSec: number
      playing: boolean
      playbackRate: number
    }
  ) => Promise<unknown>
  suppressDeckCueClick: Record<HorizontalBrowseDeckKey, boolean>
}

export const createHorizontalBrowseDeckEjectHandler = (
  params: UseHorizontalBrowseDeckEjectParams
) => {
  return async (deck: HorizontalBrowseDeckKey) => {
    const cuePreviewState = params.resolveDeckCuePreviewRuntimeState(deck)
    const restoreSyncEnabled = cuePreviewState.active && cuePreviewState.syncEnabledBefore
    cuePreviewState.active = false
    cuePreviewState.pointerId = null
    cuePreviewState.cueSeconds = 0
    cuePreviewState.syncEnabledBefore = false
    cuePreviewState.syncLockBefore = 'off'
    cuePreviewState.token += 1
    params.suppressDeckCueClick[deck] = false

    params.setDeckSong(deck, null)
    const nowMs = performance.now()
    await params.commitDeckStateToNative(deck, {
      currentSec: 0,
      lastObservedAtMs: nowMs,
      durationSec: 0,
      playing: false,
      playbackRate: 1
    })
    // CUE 试听会临时关闭同步；卸载歌曲后恢复轨道开关，避免把临时状态留给下一首。
    if (restoreSyncEnabled && !params.resolveTransportDeckSnapshot(deck).syncEnabled) {
      await params.nativeTransport.setSyncEnabled(deck, true)
    }
  }
}
