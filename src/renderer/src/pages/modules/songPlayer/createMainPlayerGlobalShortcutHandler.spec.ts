import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { IpcRendererEvent } from 'electron'
import { createMainPlayerGlobalShortcutHandler } from './createMainPlayerGlobalShortcutHandler'

const createHandler = (overrides?: {
  waveformShow?: boolean
  seekPercent?: (percent: number) => void
}) => {
  const seekPercent = overrides?.seekPercent ?? vi.fn()
  const togglePlayPause = vi.fn()
  const handler = createMainPlayerGlobalShortcutHandler({
    previewHotkeysActive: ref(false),
    selectSongListDialogShow: ref(false),
    waveformShow: ref(overrides?.waveformShow ?? true),
    isGlobalSelectSongListDialogVisible: () => false,
    togglePlayPause,
    fastForward: vi.fn(),
    fastBackward: vi.fn(),
    nextSong: vi.fn(),
    previousSong: vi.fn(),
    seekPercent
  })
  return { handler, seekPercent, togglePlayPause }
}

describe('createMainPlayerGlobalShortcutHandler', () => {
  it('将 seekPercent 立刻分发给定位回调', () => {
    const { handler, seekPercent } = createHandler()
    handler({} as IpcRendererEvent, { action: 'seekPercent', percent: 0.4 })
    expect(seekPercent).toHaveBeenCalledWith(0.4)
  })

  it('波形未显示时忽略全局定位', () => {
    const { handler, seekPercent } = createHandler({ waveformShow: false })
    handler({} as IpcRendererEvent, { action: 'seekPercent', percent: 0.2 })
    expect(seekPercent).not.toHaveBeenCalled()
  })

  it('仍兼容旧的纯 action 字符串', () => {
    const { handler, togglePlayPause } = createHandler()
    handler({} as IpcRendererEvent, 'togglePlayPause')
    expect(togglePlayPause).toHaveBeenCalledTimes(1)
  })
})
