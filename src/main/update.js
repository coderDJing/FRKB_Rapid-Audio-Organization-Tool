import { log } from './log.js'

const { autoUpdater } = require('electron-updater')

autoUpdater.checkForUpdates()

autoUpdater.on('checking-for-update', () => {
  //todo 更新相关逻辑
  log.error('autoUpdater', 'checking-for-update')
})

autoUpdater.on('update-available', (info) => {
  //todo 更新相关逻辑
  log.error('autoUpdater', 'update-available', info)
})

autoUpdater.on('update-not-available', (info) => {
  //todo 更新相关逻辑
  log.error('autoUpdater', 'update-not-available', info)
})

autoUpdater.on('error', (err) => {
  //todo 更新相关逻辑
  log.error('autoUpdater', 'error', err)
})

autoUpdater.on('download-progress', (progressObj) => {
  //todo 更新相关逻辑
  log.error('autoUpdater', 'download-progress', progressObj)
  // let log_message = 'Download speed: ' + progressObj.bytesPerSecond
  // log_message = log_message + ' - Downloaded ' + progressObj.percent + '%'
  // log_message = log_message + ' (' + progressObj.transferred + '/' + progressObj.total + ')'
})

autoUpdater.on('update-downloaded', (info) => {
  //todo 更新相关逻辑
  log.error('autoUpdater', 'update-downloaded', info)
  // sendStatusToWindow('Update downloaded')
})
