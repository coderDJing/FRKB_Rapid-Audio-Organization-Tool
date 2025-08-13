import url from './url'
import path = require('path')
import { app } from 'electron'
export import log = require('electron-log')

log.transports.file.level = 'debug' // 设置日志级别
const appVersion = (() => {
  try {
    return app.getVersion()
  } catch (_e) {
    return 'unknown'
  }
})()
log.transports.file.format = `{y}-{m}-{d} {h}:{i}:{s}.{ms} [v${appVersion}] {text}` // 自定义日志格式，带版本号
log.transports.file.maxSize = 5 * 1024 * 1024 // 设置日志文件的最大大小，‌例如5MB
log.transports.file.resolvePathFn = () => path.join(url.userDataDir, 'log.txt') // 指定日志文件的存储路径
process.on('uncaughtException', (error) => {
  log.error(error)
})

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
