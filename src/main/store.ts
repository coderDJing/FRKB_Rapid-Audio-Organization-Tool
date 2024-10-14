let songFingerprintList: string[] = [] //声音指纹列表
let databaseDir: string = '' //数据库目录

type ILayoutConfig = {
  libraryAreaWidth: number
  isMaxMainWin: boolean
  mainWindowWidth: number
  mainWindowHeight: number
}
let layoutConfig: ILayoutConfig | null = null //界面布局config

type ISettingConfig = {
  language: '' | 'enUS' | 'zhCN'
  audioExt: string[]
  databaseUrl: string
  globalCallShortcut: string
  nextCheckUpdateTime: number
}
let settingConfig: ISettingConfig = {
  language: '',
  audioExt: [],
  databaseUrl: '',
  globalCallShortcut: '',
  nextCheckUpdateTime: 0
} //设置config
let analyseSongPort: string = ''
export default {
  songFingerprintList,
  databaseDir,
  layoutConfig,
  settingConfig,
  analyseSongPort
}
