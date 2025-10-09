/// <reference types="electron-vite/node" />
import { ElectronAPI } from '@electron-toolkit/preload'
import { PreloadApi } from '../preload/index'
import { IPicture } from 'music-metadata'

interface IDir {
  uuid: string
  type: 'root' | 'library' | 'dir' | 'songList'
  dirName: string
  order?: number
  children?: IDir[]
}

type md5 = {
  sha256_Hash: string
  file_path: string
  error?: string
}

// 指纹相关类型已移除（当前仅使用音频内容哈希判重）

declare global {
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}

interface ISongInfo {
  filePath: string
  cover: IPicture | null
  title: string | undefined
  artist: string | undefined
  album: string | undefined
  duration: string
  genre: string | undefined
  label: string | undefined
  bitrate: number | undefined
  container: string | undefined
}

interface ILayoutConfig {
  libraryAreaWidth: number
  isMaxMainWin: boolean
  mainWindowWidth: number
  mainWindowHeight: number
}

interface ISettingConfig {
  platform: 'win32' | 'darwin'
  language: '' | 'enUS' | 'zhCN'
  audioExt: string[]
  databaseUrl: string
  globalCallShortcut: string
  nextCheckUpdateTime: string
  hiddenPlayControlArea: boolean
  autoPlayNextSong: boolean
  startPlayPercent: number
  endPlayPercent: number
  fastForwardTime: number
  fastBackwardTime: number
  autoScrollToCurrentSong: boolean
  enablePlaybackRange: boolean
  recentDialogSelectedSongListMaxCount: number
  // 错误日志上报设置
  enableErrorReport: boolean
  errorReportUsageMsSinceLastSuccess: number
  errorReportRetryMsSinceLastFailure: number // -1 表示当前无失败等待窗口
  // 是否在重启后保留“曲目筛选条件”（默认不保留）
  persistSongFilters: boolean
  // 是否在歌单名称后显示曲目数量
  showPlaylistTrackCount: boolean
  // 迁移标记：是否已将 .aif/.aiff 默认加入 audioExt（避免重复覆盖用户选择）
  migratedAudioExtAiffAif?: boolean
}

interface ILanguageDict {
  [key: string]: {
    [key: string]: string | string[]
  }
}
interface IMenu {
  menuName: string
  shortcutKey?: string
}

interface IImportSongsFormData {
  filePaths?: string[]
  folderPath?: string[]
  selectedPaths?: string[]
  songListPath: string
  isDeleteSourceFile: boolean
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
  songListUUID: string
}

interface ISongsAreaColumn {
  columnName: string
  key: string
  show: boolean
  width: number
  order?: 'asc' | 'desc'
  // 可选：列筛选能力与状态（仅在实现列筛选功能时使用）
  // filterType：'text' 适用于标题/艺人/专辑/流派/厂牌/格式等；'duration' 适用于时长列
  filterType?: 'text' | 'duration'
  // 是否存在生效的筛选（用于列头图标高亮与关键字展示）
  filterActive?: boolean
  // 文本筛选：关键字（包含匹配，不区分大小写）
  filterValue?: string
  // 时长筛选：操作符与目标时长（固定 MM:SS 字符串）
  filterOp?: 'eq' | 'gte' | 'lte'
  filterDuration?: string
}

type Icon = {
  name: 'FilterLibrary' | 'CuratedLibrary' | 'RecycleBin'
  grey: string
  white: string
  src: string
  showAlt: boolean
}
export {
  md5,
  IDir,
  ISongInfo,
  ILayoutConfig,
  ISettingConfig,
  ILanguageDict,
  IMenu,
  IImportSongsFormData,
  ISongsAreaColumn,
  Icon
}
