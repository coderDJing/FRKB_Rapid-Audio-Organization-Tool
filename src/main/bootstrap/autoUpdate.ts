import { app } from 'electron'
import electronUpdater = require('electron-updater')
import updateWindow from '../window/updateWindow'
import foundNewVersionWindow from '../window/foundNewVersionWindow'
import store from '../store'

export function setupAutoUpdate() {
  const autoUpdater = electronUpdater.autoUpdater
  autoUpdater.autoDownload = false
  const versionString = app.getVersion()
  const isPrerelease = versionString.includes('-')

  try {
    ;(autoUpdater as any).allowPrerelease = isPrerelease
  } catch {}

  try {
    if (isPrerelease && /-rc[.-]/i.test(versionString)) {
      ;(autoUpdater as any).channel = 'rc'
    }
  } catch {}

  if (store.settingConfig.nextCheckUpdateTime) {
    if (new Date() > new Date(store.settingConfig.nextCheckUpdateTime)) {
      autoUpdater.checkForUpdates()
    }
  } else {
    autoUpdater.checkForUpdates()
  }

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = !!(
      info &&
      typeof (info as any).version === 'string' &&
      (info as any).version.includes('-')
    )

    if (currentIsPrerelease !== remoteIsPrerelease) {
      return
    }
    if (updateWindow.instance === null) {
      foundNewVersionWindow.createWindow()
    }
  })
}
