import { app } from 'electron'
import path = require('path')

const isPackagedRuntime = (() => {
  try {
    return !!(app && typeof app.isPackaged === 'boolean' && app.isPackaged)
  } catch {
    return false
  }
})()

let userDataDir = ''
if (isPackagedRuntime) {
  try {
    userDataDir = app.getPath('userData')
  } catch {
    userDataDir = __dirname
  }
} else {
  userDataDir = __dirname
}
let layoutConfigFileUrl = path.join(userDataDir, 'config', 'layoutConfig.json')
let settingConfigFileUrl = path.join(userDataDir, 'config', 'settingConfig.json')
export default {
  userDataDir,
  layoutConfigFileUrl,
  settingConfigFileUrl
}
