import { ILayoutConfig, ISettingConfig } from 'src/types/globals'

let songFingerprintList: string[] = [] //声音指纹列表
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
  recentDialogSelectedSongListMaxCount: 10
} //设置config
let analyseSongPort: string = ''
export default {
  songFingerprintList,
  databaseDir,
  layoutConfig,
  settingConfig,
  analyseSongPort
}
