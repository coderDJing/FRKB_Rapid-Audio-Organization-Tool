import { app } from 'electron'
import enUsUrl from '../renderer/src/language/enUS.json?commonjs-external&asset'

import path = require('path')

const analyseSongPyScriptUrl = path
  .join(
    __dirname,
    '../../resources/pyScript/analyseSong/analyseSong' +
      (process.platform === 'darwin' ? '' : '.exe')
  )
  .replace('app.asar', 'app.asar.unpacked')
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
  analyseSongPyScriptUrl,
  userDataDir,
  layoutConfigFileUrl,
  settingConfigFileUrl
}
