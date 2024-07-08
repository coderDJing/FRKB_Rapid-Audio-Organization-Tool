
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
      selectSongListDialogShow: false
    }
  }
})
