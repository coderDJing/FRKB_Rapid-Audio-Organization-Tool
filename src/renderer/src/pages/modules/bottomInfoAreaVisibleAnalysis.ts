import { computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { hasDisplayableAnalysisProgressForSongs } from '@renderer/pages/modules/songsArea/composables/useKeyAnalysisProgress'

export const useBottomInfoVisibleAnalysisProgress = () => {
  const runtime = useRuntimeStore()

  return computed(() => {
    if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
      return Number(runtime.pioneerDeviceLibrary.visibleAnalysisProgressCount || 0) > 0
    }
    if (runtime.songsAreaPanels.splitEnabled) {
      return (
        hasDisplayableAnalysisProgressForSongs(runtime.songsAreaPanels.panes.left.songInfoArr) ||
        hasDisplayableAnalysisProgressForSongs(runtime.songsAreaPanels.panes.right.songInfoArr)
      )
    }
    return hasDisplayableAnalysisProgressForSongs(runtime.songsArea.songInfoArr)
  })
}
