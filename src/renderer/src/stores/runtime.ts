import { defineStore } from 'pinia'
import { IDir, ILayoutConfig, ISettingConfig, ISongInfo } from 'src/types/globals'
interface Runtime {
  platform: string
  isWindowMaximized: boolean | null
  libraryAreaSelected: 'FilterLibrary' | 'CuratedLibrary' | 'RecycleBin'
  activeMenuUUID: string
  layoutConfig: ILayoutConfig
  dragItemData: null | IDir
  dragTableHeader: boolean
  libraryTree: IDir
  oldLibraryTree: IDir
  selectSongListDialogShow: boolean
  dialogSelectedSongListUUID: string
  songsArea: {
    songListUUID: string
    songInfoArr: ISongInfo[]
    selectedSongFilePath: string[]
  }
  importingSongListUUID: string
  isProgressing: boolean
  playingData: {
    playingSong: null | ISongInfo
    playingSongListUUID: string
    playingSongListData: ISongInfo[]
  }
  confirmShow: boolean
  hotkeysScopesHeap: string[]
  setting: ISettingConfig
  // 播放器是否已加载并就绪（用于快进等操作的前置条件）
  playerReady: boolean
  // 是否处于切歌流程中（从发起切歌到新歌开始播放之前）
  isSwitchingSong: boolean
}
export const useRuntimeStore = defineStore('runtime', {
  state: (): Runtime => {
    return {
      platform: '', //使用平台
      isWindowMaximized: null,
      libraryAreaSelected: 'FilterLibrary',
      activeMenuUUID: '',
      layoutConfig: {
        libraryAreaWidth: 200,
        isMaxMainWin: false, //上次关闭前是否最大化
        mainWindowWidth: 900, //上次关闭前窗口化时的宽
        mainWindowHeight: 600 //上次关闭前窗口化时的高
      },
      dragItemData: null,
      dragTableHeader: false, //是否正在拖拽表头
      libraryTree: {
        uuid: '',
        type: 'root',
        dirName: 'library',
        order: 1
      },
      oldLibraryTree: {
        uuid: '',
        type: 'root',
        dirName: 'library',
        order: 1
      },
      selectSongListDialogShow: false, //全局是否有歌单选择器正在展示
      dialogSelectedSongListUUID: '', //dialog中被选中的歌单UUID
      songsArea: {
        songListUUID: '', //被选中的歌单UUID
        songInfoArr: [], //歌单内容
        selectedSongFilePath: [] //歌单内选中的歌曲条目
      },
      importingSongListUUID: '', //正在执行导入中的歌单
      isProgressing: false, //正在执行某计算或IO任务
      playingData: {
        //播放器相关
        playingSong: null, //正在播放的歌曲信息
        playingSongListUUID: '', //正在播放的歌单的UUID
        playingSongListData: [] //正在播放的歌单的曲目数组
      },
      confirmShow: false, //是否有确认框正在显示
      hotkeysScopesHeap: [], //hotkeys-js的scope组成的堆栈，始终setScope数组的最后一项
      setting: {
        platform: 'win32',
        language: '',
        audioExt: [],
        databaseUrl: '',
        globalCallShortcut: '',
        nextCheckUpdateTime: '',
        hiddenPlayControlArea: false,
        autoPlayNextSong: false,
        startPlayPercent: 0,
        endPlayPercent: 100,
        fastForwardTime: 10,
        fastBackwardTime: -5,
        autoScrollToCurrentSong: true,
        enablePlaybackRange: false,
        recentDialogSelectedSongListMaxCount: 10,
        enableErrorReport: true,
        errorReportUsageMsSinceLastSuccess: 0,
        errorReportRetryMsSinceLastFailure: -1,
        persistSongFilters: false
      }, //设置
      playerReady: false,
      isSwitchingSong: false
    }
  }
})
