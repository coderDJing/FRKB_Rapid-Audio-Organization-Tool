import { ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
// ISongInfo might not be directly needed here unless we manipulate song data deeply
// but runtime store interaction will involve it indirectly.

export type MoveSongsLibraryName = 'CuratedLibrary' | 'FilterLibrary'

export function useSelectAndMoveSongs() {
  const runtime = useRuntimeStore()

  const isDialogVisible = ref(false)
  const targetLibraryName = ref<MoveSongsLibraryName | ''>('')

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

    const sourceSongListUUID = runtime.songsArea.songListUUID
    const selectedPaths = JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
    if (!selectedPaths.length) return

    await window.electron.ipcRenderer.invoke(
      'moveSongsToDir',
      selectedPaths,
      libraryUtils.findDirPathByUuid(targetSongListUUID)
    )

    // 不在此处直接修改 original 或 runtime.songsArea.songInfoArr，
    // 统一通过全局事件在 songsArea.vue 中处理，避免与排序/筛选链路竞态。
    runtime.songsArea.selectedSongFilePath.length = 0 // 清空选择

    // 通知全局，保证 songsArea 与其他视图收到统一的移除事件
    emitter.emit('songsRemoved', {
      listUUID: runtime.songsArea.songListUUID,
      paths: selectedPaths
    })

    console.log('[SongsArea] MOVE_DIALOG_CONFIRMED', {
      fromList: runtime.songsArea.songListUUID,
      moved: selectedPaths.length
    })

    // 同步通知源/目标歌单数量刷新
    try {
      const affected = [sourceSongListUUID, targetSongListUUID].filter(Boolean)
      emitter.emit('playlistContentChanged', { uuids: affected })
    } catch {}
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
