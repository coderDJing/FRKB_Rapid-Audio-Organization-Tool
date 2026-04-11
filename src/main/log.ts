import url from './url'
import path = require('path')
import { app } from 'electron'
import fs = require('fs-extra')
export import log = require('electron-log')

const isPackagedRuntime = (() => {
  try {
    return !!(app && typeof app.isPackaged === 'boolean' && app.isPackaged)
  } catch {
    return false
  }
})()

const isDevRuntime = (() => {
  if (String(process.env.NODE_ENV || '').trim() === 'development') return true
  if (String(process.env.VITE_DEV_SERVER_URL || '').trim()) return true
  return !isPackagedRuntime
})()

log.transports.file.level = 'debug' // 设置日志级别
const appVersion = (() => {
  try {
    return app.getVersion()
  } catch (_e) {
    return 'unknown'
  }
})()
log.transports.file.format = `{y}-{m}-{d} {h}:{i}:{s}.{ms} [v${appVersion}] {text}` // 自定义日志格式，带版本号
log.transports.file.maxSize = 20 * 1024 * 1024 // 提高上限，避免长时间追踪时日志过快轮转

// dev 模式下日志保存在项目根目录，生产模式下保存在用户数据目录
log.transports.file.resolvePathFn = () => {
  if (isDevRuntime) {
    // dev 模式：保存到项目根目录
    return path.join(process.cwd(), 'log.txt')
  } else {
    // 生产模式：保存到用户数据目录
    return path.join(url.userDataDir, 'log.txt')
  }
}

// 导出获取日志路径的函数，供其他模块使用
export function getLogPath(): string {
  if (isDevRuntime) {
    return path.join(process.cwd(), 'log.txt')
  } else {
    return path.join(url.userDataDir, 'log.txt')
  }
}

export function clearLogFileSync(): void {
  try {
    const filePath = getLogPath()
    fs.outputFileSync(filePath, '')
  } catch (e) {
    log.error('[log] 清空日志失败', e)
  }
}

export type ExpectedErrorRule = {
  code?: string
  messageIncludes?: RegExp
}

type ErrorLike = {
  code?: unknown
  message?: unknown
}

// 预期内错误规则集中定义，后续可在此追加
const expectedErrorRules: ExpectedErrorRule[] = [
  { code: 'ENOSPC' },
  { messageIncludes: /no space left on device/i }
]

export function isExpectedError(error: unknown): boolean {
  try {
    const err = (error && typeof error === 'object' ? error : null) as ErrorLike | null
    const code = String(err?.code || '').toUpperCase()
    const message = String(err?.message || '')
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

process.on('unhandledRejection', (reason: unknown, promise) => {
  if (isExpectedError(reason)) return
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
