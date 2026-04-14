import libraryUtils from '@renderer/utils/libraryUtils'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'

interface UseSweepCoversParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
}

export function useSweepCovers(params: UseSweepCoversParams) {
  const { runtime, songsAreaState } = params
  let sweepTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleSweepCovers() {
    if (sweepTimer) {
      clearTimeout(sweepTimer)
    }
    sweepTimer = setTimeout(() => {
      try {
        const listRootDir = libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
        const currentPaths = songsAreaState.songInfoArr.map((s) => s.filePath)
        window.electron.ipcRenderer.invoke('sweepSongListCovers', listRootDir, currentPaths)
      } catch {}
    }, 300)
  }

  return { scheduleSweepCovers }
}
