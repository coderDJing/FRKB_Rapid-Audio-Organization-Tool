import { ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
// ISongInfo might not be directly needed here unless we manipulate song data deeply
// but runtime store interaction will involve it indirectly.

export type MoveSongsLibraryName = '精选库' | '筛选库'

export function useSelectAndMoveSongs() {
  const runtime = useRuntimeStore()

  const isDialogVisible = ref(false)
  const targetLibraryName = ref<MoveSongsLibraryName | ''>('')

  /**
   * Initiates the process of moving songs by showing the dialog.
   * @param libraryName - The target library ('精选库' or '筛选库').
   */
  const initiateMoveSongs = (libraryName: MoveSongsLibraryName) => {
    targetLibraryName.value = libraryName
    isDialogVisible.value = true
  }

  /**
   * Handles the confirmation from the select song list dialog.
   * Moves selected songs to the chosen directory and updates the store.
   * @param targetSongListUUID - The UUID of the target song list.
   */
  const handleMoveSongsConfirm = async (targetSongListUUID: string) => {
    isDialogVisible.value = false
    if (targetSongListUUID === runtime.songsArea.songListUUID) {
      // Moving to the same list, do nothing.
      return
    }

    const selectedPaths = JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
    if (!selectedPaths.length) return

    await window.electron.ipcRenderer.invoke(
      'moveSongsToDir',
      selectedPaths,
      libraryUtils.findDirPathByUuid(targetSongListUUID)
    )

    // Create a new array for songInfoArr after filtering
    const newSongInfoArr = runtime.songsArea.songInfoArr.filter((item) => {
      if (!selectedPaths.includes(item.filePath)) {
        return true
      } else {
        // Revoke object URL for songs being removed from the current list
        if (item.coverUrl) {
          URL.revokeObjectURL(item.coverUrl)
        }
        return false
      }
    })
    runtime.songsArea.songInfoArr = newSongInfoArr

    // If the current playing list is the one being modified, update its data reference
    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      // Also, if the currently playing song was one of the moved songs, set it to null
      if (
        runtime.playingData.playingSong &&
        selectedPaths.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }
    }

    runtime.songsArea.selectedSongFilePath.length = 0 // Clear selection
  }

  const handleDialogCancel = () => {
    isDialogVisible.value = false
  }

  return {
    isDialogVisible, // To be bound to v-if or v-model of the dialog component
    targetLibraryName, // To be passed as a prop to the dialog component
    initiateMoveSongs, // To be called by the parent component to start the process
    handleMoveSongsConfirm, // To be called by the dialog component on confirm event
    handleDialogCancel // To be called by the dialog component on cancel event
  }
}
