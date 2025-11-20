import { ILayoutConfig, ISettingConfig } from 'src/types/globals'

let songFingerprintList: string[] = [] //声音指纹列表（基于音频内容哈希）
let databaseDir: string = '' //数据库目录

let layoutConfig: ILayoutConfig = {
  libraryAreaWidth: 175,
  isMaxMainWin: false,
  mainWindowWidth: 900,
  mainWindowHeight: 600
} //界面布局config

let settingConfig: ISettingConfig = {
  platform: 'win32',
  language: '',
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
  nextCheckUpdateTime: '',
  hiddenPlayControlArea: false,
  waveformStyle: 'SoundCloud' as 'SoundCloud' | 'RGB',
  waveformMode: 'half',
  autoPlayNextSong: false,
  startPlayPercent: 0,
  endPlayPercent: 100,
  fastForwardTime: 10,
  fastBackwardTime: -5,
  autoScrollToCurrentSong: true,
  enablePlaybackRange: false,
  recentDialogSelectedSongListMaxCount: 10,
  audioOutputDeviceId: '',
  // 错误日志上报默认配置
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1,
  persistSongFilters: false,
  enableExplorerContextMenu: false,
  showPlaylistTrackCount: true,
  lastSeenWhatsNewVersion: '',
  pendingWhatsNewForVersion: ''
} //设置config
let analyseSongPort: string = ''
export default {
  songFingerprintList,
  databaseDir,
  layoutConfig,
  settingConfig,
  analyseSongPort
}
