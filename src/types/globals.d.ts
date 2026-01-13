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
  fileName: string
  fileFormat: string
  cover: IPicture | null
  title: string | undefined
  artist: string | undefined
  album: string | undefined
  duration: string
  genre: string | undefined
  label: string | undefined
  bitrate: number | undefined
  container: string | undefined
  key?: string
  bpm?: number
  analysisOnly?: boolean
  deletedAtMs?: number
  originalPlaylistPath?: string | null
  recycleBinSourceType?: string | null
}

// 曲目完整元数据明细，用于编辑界面展示
interface ITrackMetadataDetail {
  filePath: string
  fileName: string
  fileExtension: string
  durationSeconds?: number
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  trackNo?: number | null
  trackTotal?: number | null
  discNo?: number | null
  discTotal?: number | null
  year?: string
  genre?: string
  composer?: string
  lyricist?: string
  label?: string
  isrc?: string
  comment?: string
  lyrics?: string
  cover?: {
    dataUrl: string
    format?: string
  } | null
}

interface IMusicBrainzSearchPayload {
  filePath: string
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
}

interface IMusicBrainzAcoustIdPayload {
  filePath: string
  durationSeconds?: number
  maxLengthSeconds?: number
}

interface IMusicBrainzMatch {
  recordingId: string
  title: string
  artist: string
  releaseId?: string
  releaseTitle?: string
  releaseDate?: string
  country?: string
  disambiguation?: string
  score: number
  matchedFields: string[]
  durationSeconds?: number
  durationDiffSeconds?: number
  isrc?: string
  source?: 'search' | 'acoustid'
  acoustIdScore?: number
  isLowConfidence?: boolean
}

interface IMusicBrainzSuggestion {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: string
  genre?: string
  label?: string
  isrc?: string
  trackNo?: number
  trackTotal?: number
  discNo?: number
  discTotal?: number
  coverDataUrl?: string | null
}

interface IMusicBrainzSuggestionResult {
  suggestion: IMusicBrainzSuggestion
  source: {
    recordingId: string
    releaseId?: string
  }
  releaseTitle?: string
  releaseDate?: string
  country?: string
  label?: string
  artistCredit?: string
}

interface IMusicBrainzSuggestionParams {
  recordingId: string
  releaseId?: string
  allowFallback?: boolean
  cancelToken?: { cancelled: boolean }
}

interface IMusicBrainzApplyPayload {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: string
  genre?: string
  label?: string
  isrc?: string
  trackNo?: number
  trackTotal?: number
  discNo?: number
  discTotal?: number
  coverDataUrl?: string | null
}

// 元数据更新请求结构
interface ITrackMetadataUpdatePayload {
  filePath: string
  newBaseName?: string
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  trackNo?: number | null
  trackTotal?: number | null
  discNo?: number | null
  discTotal?: number | null
  year?: string
  genre?: string
  composer?: string
  lyricist?: string
  label?: string
  isrc?: string
  comment?: string
  lyrics?: string
  coverDataUrl?: string | null
}

type IMetadataAutoFillStatus = 'applied' | 'no-match' | 'skipped' | 'error' | 'cancelled'
type IMetadataAutoFillMethod = 'fingerprint' | 'search'

interface IMetadataAutoFillRequest {
  filePaths: string[]
  progressId?: string
}

interface IMetadataAutoFillItemResult {
  filePath: string
  displayName: string
  status: IMetadataAutoFillStatus
  method?: IMetadataAutoFillMethod
  messageCode?: string
  messageDetail?: string
  updatedSongInfo?: ISongInfo
  oldFilePath?: string
}

interface IMetadataAutoFillSummary {
  total: number
  applied: number
  fingerprintApplied: number
  searchApplied: number
  noMatch: number
  skipped: number
  cancelled: number
  errors: number
  durationMs: number
  progressId: string
  items: IMetadataAutoFillItemResult[]
}

interface ILayoutConfig {
  libraryAreaWidth: number
  isMaxMainWin: boolean
  mainWindowWidth: number
  mainWindowHeight: number
}

type PlayerGlobalShortcutAction = 'fastForward' | 'fastBackward' | 'nextSong' | 'previousSong'

interface IPlayerGlobalShortcuts {
  fastForward: string
  fastBackward: string
  nextSong: string
  previousSong: string
}

interface ISettingConfig {
  platform: 'win32' | 'darwin'
  language: '' | 'enUS' | 'zhCN'
  // 主题模式：system（跟随系统）/ light（浅色）/ dark（深色）
  themeMode?: 'system' | 'light' | 'dark'
  audioExt: string[]
  databaseUrl: string
  globalCallShortcut: string
  playerGlobalShortcuts: IPlayerGlobalShortcuts
  nextCheckUpdateTime: string
  hiddenPlayControlArea: boolean
  waveformStyle?: 'SoundCloud' | 'Fine' | 'RGB'
  waveformMode?: 'half' | 'full'
  keyDisplayStyle?: 'Classic' | 'Camelot'
  autoPlayNextSong: boolean
  startPlayPercent: number
  endPlayPercent: number
  fastForwardTime: number
  fastBackwardTime: number
  autoScrollToCurrentSong: boolean
  enablePlaybackRange: boolean
  recentDialogSelectedSongListMaxCount: number
  // 音频输出设备 ID，空字符串表示跟随系统默认设备
  audioOutputDeviceId: string
  // 错误日志上报设置
  enableErrorReport: boolean
  errorReportUsageMsSinceLastSuccess: number
  errorReportRetryMsSinceLastFailure: number // -1 表示当前无失败等待窗口
  // 是否在重启后保留“曲目筛选条件”（默认不保留）
  persistSongFilters: boolean
  enableExplorerContextMenu?: boolean
  windowsContextMenuSignature?: string
  // 是否在歌单名称后显示曲目数量
  showPlaylistTrackCount: boolean
  // 迁移标记：是否已将 .aif/.aiff 默认加入 audioExt（避免重复覆盖用户选择）
  migratedAudioExtAiffAif?: boolean
  // 指纹模式：pcm（解码后内容哈希）或 file（整文件哈希）
  fingerprintMode?: 'pcm' | 'file'
  // 云同步用户 Key（由设置页配置）
  cloudSyncUserKey?: string
  // 音频转换默认项（记住用户上次选择）
  convertDefaults?: {
    targetFormat:
      | 'mp3'
      | 'flac'
      | 'wav'
      | 'aif'
      | 'aiff'
      | 'ogg'
      | 'opus'
      | 'aac'
      | 'm4a'
      | 'mp4'
      | 'wma'
      | 'ac3'
      | 'dts'
      | 'mka'
      | 'webm'
      | 'wv'
      | 'tta'
    bitrateKbps?: number
    sampleRate?: 44100 | 48000
    channels?: 1 | 2
    preserveMetadata?: boolean
    normalize?: boolean
    strategy: 'new_file' | 'replace'
    overwrite?: boolean
    backupOnReplace?: boolean
    addFingerprint?: boolean
  }
  // “更新日志”窗口记录：最后看到的版本号
  lastSeenWhatsNewVersion?: string
  // 若上次拉取失败，需要下次继续尝试的版本号
  pendingWhatsNewForVersion?: string
  // AcoustID 客户端 Key（声纹匹配）
  acoustIdClientKey?: string
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
  deduplicateMode?: 'library' | 'batch' | 'none'
  songListUUID: string
}

interface ISongsAreaColumn {
  columnName: string
  key: string
  show: boolean
  width: number
  order?: 'asc' | 'desc'
  // 可选：列筛选能力与状态（仅在实现列筛选功能时使用）
  // filterType：'text' 适用于标题/艺人/专辑/流派/厂牌/格式等；'duration' 适用于时长列；'bpm' 适用于 BPM 列
  filterType?: 'text' | 'duration' | 'bpm'
  // 是否存在生效的筛选（用于列头图标高亮与关键字展示）
  filterActive?: boolean
  // 文本筛选：关键字（包含匹配，不区分大小写）
  filterValue?: string
  // 时长筛选：操作符与目标时长（固定 MM:SS 字符串）
  filterOp?: 'eq' | 'gte' | 'lte'
  filterDuration?: string
  // BPM 筛选：目标数值（支持小数）
  filterNumber?: string
}

type Icon = {
  name: 'FilterLibrary' | 'CuratedLibrary' | 'RecycleBin' | 'ExternalPlaylist'
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}
export {
  md5,
  IDir,
  ISongInfo,
  ITrackMetadataDetail,
  ITrackMetadataUpdatePayload,
  IMetadataAutoFillRequest,
  IMetadataAutoFillItemResult,
  IMetadataAutoFillSummary,
  ILayoutConfig,
  ISettingConfig,
  IPlayerGlobalShortcuts,
  PlayerGlobalShortcutAction,
  ILanguageDict,
  IMenu,
  IImportSongsFormData,
  ISongsAreaColumn,
  Icon,
  IMusicBrainzSearchPayload,
  IMusicBrainzMatch,
  IMusicBrainzAcoustIdPayload,
  IMusicBrainzSuggestion,
  IMusicBrainzSuggestionResult,
  IMusicBrainzSuggestionParams,
  IMusicBrainzApplyPayload
}
