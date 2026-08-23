import { app } from 'electron'
import path = require('path')

const resolveUserDataDir = () => {
  try {
    return app.getPath('userData')
  } catch {
    return __dirname
  }
}

const buildConfigPaths = (userDataDir: string) => ({
  userDataDir,
  layoutConfigFileUrl: path.join(userDataDir, 'config', 'layoutConfig.json'),
  settingConfigFileUrl: path.join(userDataDir, 'config', 'settingConfig.json')
})

const url = buildConfigPaths(resolveUserDataDir())

export const setUserDataDir = (userDataDir: string) => {
  Object.assign(url, buildConfigPaths(userDataDir))
}

export default url
