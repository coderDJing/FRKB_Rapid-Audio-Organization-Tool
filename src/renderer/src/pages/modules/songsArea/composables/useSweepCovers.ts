import libraryUtils from '@renderer/utils/libraryUtils'
import type { useRuntimeStore } from '@renderer/stores/runtime'

interface UseSweepCoversParams {
  runtime: ReturnType<typeof useRuntimeStore>
}

export function useSweepCovers(params: UseSweepCoversParams) {
  const { runtime } = params
  let sweepTimer: any = null

  function scheduleSweepCovers() {
    clearTimeout(sweepTimer)
    sweepTimer = setTimeout(() => {
      try {
        const listRootDir = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID) || ''
        const currentPaths = runtime.songsArea.songInfoArr.map((s) => s.filePath)
        window.electron.ipcRenderer.invoke('sweepSongListCovers', listRootDir, currentPaths)
      } catch {}
    }, 300)
  }

  return { scheduleSweepCovers }
}
