import { defineStore } from 'pinia'
import {
  ICuratedArtistFavorite,
  IDir,
  ILayoutConfig,
  IRekordboxLibraryBrowserState,
  ISettingConfig,
  ISongInfo,
  ISongsAreaColumn
} from 'src/types/globals'
export type LibrarySelection =
  | 'FilterLibrary'
  | 'CuratedLibrary'
  | 'MixtapeLibrary'
  | 'RecycleBin'
  | 'ExternalPlaylist'
  | 'PioneerDeviceLibrary'

type MainWindowBrowseMode = 'browser' | 'horizontal'
export type SongsAreaPaneKey = 'single' | 'left' | 'right'
export type SplitSongsAreaPaneKey = 'left' | 'right'
export type SongsAreaColumnMode = 'default' | 'recycle' | 'mixtape'

export interface ISongsAreaState {
  songListUUID: string
  songInfoArr: ISongInfo[]
  totalSongCount: number
  selectedSongFilePath: string[]
  scrollTop: number
  scrollLeft: number
}

export interface ISongsAreaPaneRuntimeState extends ISongsAreaState {
  columnCacheByMode: Partial<Record<SongsAreaColumnMode, ISongsAreaColumn[]>>
}

const createSongsAreaState = (): ISongsAreaPaneRuntimeState => ({
  songListUUID: '',
  songInfoArr: [],
  totalSongCount: 0,
  selectedSongFilePath: [],
  scrollTop: 0,
  scrollLeft: 0,
  columnCacheByMode: {}
})

const assignSongsAreaState = (
  target: ISongsAreaPaneRuntimeState,
  source?: Partial<ISongsAreaPaneRuntimeState> | null
) => {
  target.songListUUID = String(source?.songListUUID || '')
  target.songInfoArr = Array.isArray(source?.songInfoArr) ? [...source.songInfoArr] : []
  target.totalSongCount = Number(source?.totalSongCount || 0)
  target.selectedSongFilePath = Array.isArray(source?.selectedSongFilePath)
    ? [...source.selectedSongFilePath]
    : []
  target.scrollTop =
    typeof source?.scrollTop === 'number' && Number.isFinite(source.scrollTop)
      ? source.scrollTop
      : 0
  target.scrollLeft =
    typeof source?.scrollLeft === 'number' && Number.isFinite(source.scrollLeft)
      ? source.scrollLeft
      : 0
  const nextCache: ISongsAreaPaneRuntimeState['columnCacheByMode'] = {}
  const sourceCache = source?.columnCacheByMode
  if (sourceCache && typeof sourceCache === 'object') {
    for (const key of ['default', 'recycle', 'mixtape'] as const) {
      const cached = sourceCache[key]
      if (Array.isArray(cached)) {
        nextCache[key] = cached.map((item) => ({ ...item }))
      }
    }
  }
  target.columnCacheByMode = nextCache
}

const clearSongsAreaState = (target: ISongsAreaPaneRuntimeState) => {
  assignSongsAreaState(target, null)
}
type AnalysisRuntimeDownloadStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'extracting'
  | 'ready'
  | 'failed'

type AnalysisRuntimeDownloadState = {
  status: AnalysisRuntimeDownloadStatus
  profile: string
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

type AnalysisRuntimePreferredInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: string
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
}

interface Runtime {
  platform: string
  isWindowMaximized: boolean | null
  mainWindowBrowseMode: MainWindowBrowseMode
  libraryAreaSelected: LibrarySelection
  activeMenuUUID: string
  layoutConfig: ILayoutConfig
  dragItemData: null | IDir
  dragTableHeader: boolean
  songDragActive: boolean
  songDragMode: '' | 'internal' | 'external'
  draggingSongFilePaths: string[]
  dragSourceSongListUUID: string
  dragSourceMixtapeItemIds: string[]
  songDragSuppressClickUntilMs: number
  libraryTree: IDir
  oldLibraryTree: IDir
  selectSongListDialogShow: boolean
  dialogSelectedSongListUUID: string
  songsArea: ISongsAreaPaneRuntimeState
  songsAreaPanels: {
    splitEnabled: boolean
    activePane: SongsAreaPaneKey
    panes: Record<SongsAreaPaneKey, ISongsAreaPaneRuntimeState>
  }
  lastSongListUUIDByLibrary: {
    FilterLibrary: string
    CuratedLibrary: string
    MixtapeLibrary: string
  }
  importingSongListUUID: string
  isProgressing: boolean
  analysisRuntime: {
    available: boolean
    downloadOverlayMinimized: boolean
    preferred: AnalysisRuntimePreferredInfo
    state: AnalysisRuntimeDownloadState
  }
  playingData: {
    playingSong: null | ISongInfo
    playingSongListUUID: string
    playingSongListData: ISongInfo[]
  }
  horizontalBrowseDecks: {
    topSong: null | ISongInfo
    bottomSong: null | ISongInfo
    leaderDeck: null | 'top' | 'bottom'
  }
  externalPlaylist: {
    songs: ISongInfo[]
    lastLibrarySelection: Exclude<LibrarySelection, 'ExternalPlaylist'>
  }
  pioneerDeviceLibrary: IRekordboxLibraryBrowserState
  confirmShow: boolean
  hotkeysScopesHeap: string[]
  curatedArtistFavorites: ICuratedArtistFavorite[]
  setting: ISettingConfig
  // 播放器是否已加载并就绪（用于快进等操作的前置条件）
  playerReady: boolean
  // 是否处于切歌流程中（从发起切歌到新歌开始播放之前）
  isSwitchingSong: boolean
  // 正在创建中的歌单 UUID（用于 UI 微动效）
  creatingSongListUUID: string
}
export const useRuntimeStore = defineStore('runtime', {
  state: (): Runtime => {
    const singleSongsArea = createSongsAreaState()
    const leftSongsArea = createSongsAreaState()
    const rightSongsArea = createSongsAreaState()
    return {
      platform: '', //使用平台
      isWindowMaximized: null,
      mainWindowBrowseMode: 'browser',
      libraryAreaSelected: 'FilterLibrary',
      activeMenuUUID: '',
      layoutConfig: {
        libraryAreaWidth: 200,
        isMaxMainWin: false, //上次关闭前是否最大化
        mainWindowWidth: 1260, //上次关闭前窗口化时的宽
        mainWindowHeight: 720 //上次关闭前窗口化时的高
      },
      dragItemData: null,
      dragTableHeader: false, //是否正在拖拽表头
      songDragActive: false,
      songDragMode: '',
      draggingSongFilePaths: [],
      dragSourceSongListUUID: '',
      dragSourceMixtapeItemIds: [],
      songDragSuppressClickUntilMs: 0,
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
      songsArea: singleSongsArea,
      songsAreaPanels: {
        splitEnabled: false,
        activePane: 'single',
        panes: {
          single: singleSongsArea,
          left: leftSongsArea,
          right: rightSongsArea
        }
      },
      lastSongListUUIDByLibrary: {
        FilterLibrary: '',
        CuratedLibrary: '',
        MixtapeLibrary: ''
      },
      importingSongListUUID: '', //正在执行导入中的歌单
      creatingSongListUUID: '', //正在创建中的歌单（用于微动效）
      isProgressing: false, //正在执行某计算或IO任务
      analysisRuntime: {
        available: false,
        downloadOverlayMinimized: false,
        preferred: {
          supported: false,
          downloadable: false,
          alreadyAvailable: false,
          profile: '',
          runtimeKey: '',
          version: '',
          archiveSize: 0,
          title: '',
          reason: '',
          manifestUrl: '',
          releaseTag: '',
          error: ''
        },
        state: {
          status: 'idle',
          profile: '',
          runtimeKey: '',
          version: '',
          percent: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          archiveSize: 0,
          title: '',
          message: '',
          error: '',
          updatedAt: 0
        }
      },
      playingData: {
        //播放器相关
        playingSong: null, //正在播放的歌曲信息
        playingSongListUUID: '', //正在播放的歌单的UUID
        playingSongListData: [] //正在播放的歌单的曲目数组
      },
      horizontalBrowseDecks: {
        topSong: null,
        bottomSong: null,
        leaderDeck: null
      },
      externalPlaylist: {
        songs: [],
        lastLibrarySelection: 'FilterLibrary'
      },
      pioneerDeviceLibrary: {
        selectedSourceKey: '',
        selectedSourceName: '',
        selectedSourceRootPath: '',
        selectedSourceKind: '',
        selectedLibraryType: '',
        selectedPlaylistId: 0,
        loading: false,
        treeNodes: []
      },
      confirmShow: false, //是否有确认框正在显示
      hotkeysScopesHeap: [], //hotkeys-js的scope组成的堆栈，始终setScope数组的最后一项
      curatedArtistFavorites: [],
      setting: {
        platform: 'win32',
        language: '',
        mainWindowBrowseMode: 'browser',
        themeMode: 'system',
        audioExt: [
          '.mp3',
          '.wav',
          '.flac',
          '.aif',
          '.aiff',
          '.ogg',
          '.opus',
          '.aac',
          '.m4a',
          '.mp4',
          '.wma',
          '.ac3',
          '.dts',
          '.mka',
          '.webm',
          '.ape',
          '.tak',
          '.tta',
          '.wv'
        ],
        databaseUrl: '',
        globalCallShortcut: '',
        enableWindowScreenshotShortcut: true,
        playerGlobalShortcuts: {
          fastForward: 'Shift+Alt+Right',
          fastBackward: 'Shift+Alt+Left',
          nextSong: 'Shift+Alt+Down',
          previousSong: 'Shift+Alt+Up'
        },
        nextCheckUpdateTime: '',
        hiddenPlayControlArea: false,
        waveformStyle: 'RGB',
        waveformMode: 'half',
        keyDisplayStyle: 'Classic',
        autoPlayNextSong: false,
        startPlayPercent: 0,
        endPlayPercent: 100,
        fastForwardTime: 10,
        fastBackwardTime: -5,
        autoScrollToCurrentSong: true,
        enablePlaybackRange: false,
        recentDialogSelectedSongListMaxCount: 10,
        audioOutputDeviceId: '',
        showTitleAudioVisualizer: true,
        mainWindowTitleAudioVisualizerMode: 'bars',
        mixtapeWindowTitleAudioVisualizerMode: 'bars',
        enableErrorReport: true,
        errorReportUsageMsSinceLastSuccess: 0,
        errorReportRetryMsSinceLastFailure: -1,
        persistSongFilters: false,
        enableCuratedArtistTracking: true,
        enableExplorerContextMenu: false,
        showPlaylistTrackCount: true,
        lastSeenWhatsNewVersion: '',
        pendingWhatsNewForVersion: ''
      }, //设置
      playerReady: false,
      isSwitchingSong: false
    }
  },
  actions: {
    setAnalysisRuntimeDownloadOverlayMinimized(minimized: boolean) {
      this.analysisRuntime.downloadOverlayMinimized = minimized
    },
    setSongsAreaActivePane(pane: SongsAreaPaneKey) {
      this.songsAreaPanels.activePane = pane
      this.songsArea = this.songsAreaPanels.panes[pane]
    },
    assignSongsAreaPaneState(
      pane: SongsAreaPaneKey,
      source?: Partial<ISongsAreaPaneRuntimeState> | null
    ) {
      assignSongsAreaState(this.songsAreaPanels.panes[pane], source)
      if (this.songsAreaPanels.activePane === pane) {
        this.songsArea = this.songsAreaPanels.panes[pane]
      }
    },
    clearSongsAreaPaneState(pane: SongsAreaPaneKey) {
      clearSongsAreaState(this.songsAreaPanels.panes[pane])
      if (this.songsAreaPanels.activePane === pane) {
        this.songsArea = this.songsAreaPanels.panes[pane]
      }
    }
  }
})
