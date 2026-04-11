import { app } from 'electron'
import electronUpdater = require('electron-updater')
import updateWindow from '../window/updateWindow'
import foundNewVersionWindow from '../window/foundNewVersionWindow'
import store from '../store'
import { log } from '../log'

type AutoUpdaterWithExtras = typeof electronUpdater.autoUpdater & {
  allowPrerelease?: boolean
  channel?: string
}

export function setupAutoUpdate() {
  const autoUpdater = electronUpdater.autoUpdater as AutoUpdaterWithExtras
  autoUpdater.autoDownload = false
  const versionString = app.getVersion()
  const isPrerelease = versionString.includes('-')

  try {
    autoUpdater.allowPrerelease = isPrerelease
  } catch {}

  try {
    if (isPrerelease && /-rc[.-]/i.test(versionString)) {
      autoUpdater.channel = 'rc'
    }
  } catch {}

  if (store.settingConfig.nextCheckUpdateTime) {
    if (new Date() > new Date(store.settingConfig.nextCheckUpdateTime)) {
      void autoUpdater.checkForUpdates().catch((error) => {
        log.error('[autoUpdate] initial check failed', error)
      })
    }
  } else {
    void autoUpdater.checkForUpdates().catch((error) => {
      log.error('[autoUpdate] initial check failed', error)
    })
  }

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = typeof info?.version === 'string' && info.version.includes('-')

    if (currentIsPrerelease !== remoteIsPrerelease) {
      return
    }
    if (updateWindow.instance === null) {
      foundNewVersionWindow.createWindow()
    }
  })
}
