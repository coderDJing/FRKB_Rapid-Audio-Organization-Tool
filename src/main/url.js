import { app } from 'electron'
import enUsUrl from '../renderer/src/language/enUS.json?commonjs-external&asset'
import zhCNUrl from '../renderer/src/language/zhCN.json?commonjs-external&asset'
import analyseSongPyScriptUrl from '../../resources/pyScript/analyseSong/analyseSong.exe?commonjs-external&asset&asarUnpack'
const path = require('path')
let userDataDir = ''
if (app.isPackaged) {
  userDataDir = app.getPath('userData')
} else {
  userDataDir = __dirname
}
let layoutConfigFileUrl = path.join(userDataDir, 'config', 'layoutConfig.json')
let settingConfigFileUrl = path.join(userDataDir, 'config', 'settingConfig.json')
export default {
  enUsUrl,
  zhCNUrl,
  analyseSongPyScriptUrl,
  userDataDir,
  layoutConfigFileUrl,
  settingConfigFileUrl
}
