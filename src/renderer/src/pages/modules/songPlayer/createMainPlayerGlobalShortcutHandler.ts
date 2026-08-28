import type { IpcRendererEvent } from 'electron'
import type { Ref } from 'vue'
import { normalizePlayerGlobalShortcutPayload } from '@shared/playerGlobalShortcuts'

export function createMainPlayerGlobalShortcutHandler(params: {
  previewHotkeysActive: Ref<boolean>
  selectSongListDialogShow: Ref<boolean>
  waveformShow: Ref<boolean>
  isGlobalSelectSongListDialogVisible: () => boolean
  togglePlayPause: () => void
  fastForward: () => void
  fastBackward: () => void
  nextSong: () => void
  previousSong: () => void
  seekPercent: (percent: number) => void
}) {
  return (_event: IpcRendererEvent, rawPayload: unknown) => {
    const payload = normalizePlayerGlobalShortcutPayload(rawPayload)
    if (!payload) return
    if (params.previewHotkeysActive.value || params.isGlobalSelectSongListDialogVisible()) {
      return
    }
    if (!params.waveformShow.value) {
      return
    }
    if (payload.action === 'seekPercent') {
      params.seekPercent(payload.percent)
      return
    }
    if (
      (payload.action === 'nextSong' || payload.action === 'previousSong') &&
      params.selectSongListDialogShow.value
    ) {
      return
    }
    if (payload.action === 'togglePlayPause') params.togglePlayPause()
    if (payload.action === 'fastForward') params.fastForward()
    if (payload.action === 'fastBackward') params.fastBackward()
    if (payload.action === 'nextSong') params.nextSong()
    if (payload.action === 'previousSong') params.previousSong()
  }
}
