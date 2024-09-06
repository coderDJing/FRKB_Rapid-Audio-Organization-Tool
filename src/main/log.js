import url from './url.js'
const path = require('path')
export const log = require('electron-log')

log.transports.file.level = 'debug' // 设置日志级别
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} {text}' // 自定义日志格式
log.transports.file.maxSize = 5 * 1024 * 1024 // 设置日志文件的最大大小，‌例如5MB
log.transports.file.resolvePathFn = () => path.join(url.userDataDir, 'log.txt') // 指定日志文件的存储路径
process.on('uncaughtException', (error) => {
  log.error(error)
})

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
