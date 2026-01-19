import url from './url'
import path = require('path')
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
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

// dev 模式下日志保存在项目根目录，生产模式下保存在用户数据目录
log.transports.file.resolvePathFn = () => {
  if (is.dev) {
    // dev 模式：保存到项目根目录
    return path.join(process.cwd(), 'log.txt')
  } else {
    // 生产模式：保存到用户数据目录
    return path.join(url.userDataDir, 'log.txt')
  }
}

// 导出获取日志路径的函数，供其他模块使用
export function getLogPath(): string {
  if (is.dev) {
    return path.join(process.cwd(), 'log.txt')
  } else {
    return path.join(url.userDataDir, 'log.txt')
  }
}

export type ExpectedErrorRule = {
  code?: string
  messageIncludes?: RegExp
}

// 预期内错误规则集中定义，后续可在此追加
const expectedErrorRules: ExpectedErrorRule[] = [
  { code: 'ENOSPC' },
  { messageIncludes: /no space left on device/i }
]

export function isExpectedError(error: any): boolean {
  try {
    const code = String(error?.code || '').toUpperCase()
    const message = String(error?.message || '')
    for (const rule of expectedErrorRules) {
      if (rule.code && code === rule.code) return true
      if (rule.messageIncludes && rule.messageIncludes.test(message)) return true
    }
    return false
  } catch (_e) {
    return false
  }
}
process.on('uncaughtException', (error) => {
  if (isExpectedError(error)) return
  log.error(error)
})

process.on('unhandledRejection', (reason: any, promise) => {
  if (isExpectedError(reason)) return
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
