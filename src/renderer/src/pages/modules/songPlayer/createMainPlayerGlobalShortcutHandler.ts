import type { IpcRendererEvent } from 'electron'
import type { Ref } from 'vue'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'

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
}) {
  return (_event: IpcRendererEvent, action: PlayerGlobalShortcutAction) => {
    if (params.previewHotkeysActive.value || params.isGlobalSelectSongListDialogVisible()) {
      return
    }
    if (!params.waveformShow.value) {
      return
    }
    if (
      (action === 'nextSong' || action === 'previousSong') &&
      params.selectSongListDialogShow.value
    ) {
      return
    }
    if (action === 'togglePlayPause') params.togglePlayPause()
    if (action === 'fastForward') params.fastForward()
    if (action === 'fastBackward') params.fastBackward()
    if (action === 'nextSong') params.nextSong()
    if (action === 'previousSong') params.previousSong()
  }
}
