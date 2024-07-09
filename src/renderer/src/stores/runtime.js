
import { defineStore } from 'pinia'

export const useRuntimeStore = defineStore('runtime', {
  state: () => {
    return {
      isWindowMaximized: null,
      libraryAreaSelected: 'listLibrary',
      activeMenuUUID: '',
      layoutConfig: {
        libraryAreaWidth: 200,
        scanNewSongDialog: {
          isDeleteSourceFile: true,
          isDeleteSourceDir: true
        }
      },
      dragItemData: null,
      libraryTree: {},
      selectSongListDialogShow: false,
      dialogSelectedSongListUUID: '',//dialog中被选中的歌单UUID
      selectedSongListUUID: '',//被选中的歌单UUID

    }
  }
})
