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
          isDeleteSourceFile: true, //是否删除源文件
          isDeleteSourceDir: true, //是否删除文件夹，暂时注释，无法判断文件夹是否是桌面等重要文件夹
          isComparisonSongFingerprint: true, //比对声音指纹去重
          isPushSongFingerprintLibrary: true //是否加入声音指纹库
        }
      },
      dragItemData: null,
      libraryTree: {},
      selectSongListDialogShow: false,
      dialogSelectedSongListUUID: '', //dialog中被选中的歌单UUID
      selectedSongListUUID: '' //被选中的歌单UUID
    }
  }
})
