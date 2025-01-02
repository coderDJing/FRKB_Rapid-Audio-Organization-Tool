import { app } from 'electron'
import enUsUrl from '../renderer/src/language/enUS.json?commonjs-external&asset'
import path = require('path')

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
  userDataDir,
  layoutConfigFileUrl,
  settingConfigFileUrl
}
