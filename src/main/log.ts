import path = require('path')
import fs = require('fs-extra')

type ElectronAppLike = {
  isPackaged?: boolean
  getVersion?: () => string
  getPath?: (name: string) => string
  getAppPath?: () => string
}

type ElectronLogFileLike = {
  path: string
}

type LogTransportFileLike = {
  level?: string | boolean
  format?: string
  maxSize?: number
  resolvePathFn?: () => string
  getFile?: () => ElectronLogFileLike
}

type LoggerLike = {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  transports: {
    file: LogTransportFileLike
  }
}

const safeRequire = (id: string): unknown => {
  try {
    return require(id)
  } catch {
    return null
  }
}

const electronModule =
  (safeRequire('electron') as {
    app?: ElectronAppLike
  } | null) || null
const electronApp = electronModule?.app || null

const createConsoleLogger = (): LoggerLike => ({
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  transports: {
    file: {}
  }
})

const loadedElectronLog =
  ((safeRequire('electron-log/main') || safeRequire('electron-log')) as
    | Partial<LoggerLike>
    | null
    | undefined) || null

export const log: LoggerLike =
  loadedElectronLog &&
  typeof loadedElectronLog.debug === 'function' &&
  typeof loadedElectronLog.info === 'function' &&
  typeof loadedElectronLog.warn === 'function' &&
  typeof loadedElectronLog.error === 'function' &&
  loadedElectronLog.transports &&
  typeof loadedElectronLog.transports === 'object'
    ? (loadedElectronLog as LoggerLike)
    : createConsoleLogger()

const resolveUserDataDir = () => {
  try {
    const resolved = electronApp?.getPath?.('userData')
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim()
    }
  } catch {}
  return process.cwd()
}

const isPackagedRuntime = (() => {
  try {
    return !!(electronApp && typeof electronApp.isPackaged === 'boolean' && electronApp.isPackaged)
  } catch {
    return false
  }
})()

const resolveDevProjectRoot = () => {
  const candidates = [
    process.env.INIT_CWD,
    process.cwd(),
    (() => {
      try {
        return electronApp?.getAppPath?.()
      } catch {
        return ''
      }
    })()
  ]
  for (const candidate of candidates) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : ''
    if (normalized) return normalized
  }
  return process.cwd()
}

const resolveAppVersion = () => {
  try {
    const resolved = electronApp?.getVersion?.()
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim()
    }
  } catch {}
  return 'unknown'
}

const resolveLogPath = () => {
  if (isPackagedRuntime) {
    return path.join(resolveUserDataDir(), 'logs', 'main.log')
  }
  return path.join(resolveDevProjectRoot(), 'log.txt')
}

let logConfigured = false

export function configureLogTransports(): void {
  if (!log?.transports?.file) return
  const appVersion = resolveAppVersion()
  log.transports.file.level = 'debug'
  log.transports.file.format = `{y}-{m}-{d} {h}:{i}:{s}.{ms} [v${appVersion}] {text}`
  log.transports.file.maxSize = 20 * 1024 * 1024
  log.transports.file.resolvePathFn = resolveLogPath
  logConfigured = true
}

export function ensureLogConfigured(): void {
  if (logConfigured) return
  configureLogTransports()
}

export function getLogPath(): string {
  ensureLogConfigured()
  try {
    const resolved = log.transports.file.getFile?.().path
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim()
    }
  } catch {}
  return resolveLogPath()
}

export function clearLogFileSync(): void {
  try {
    fs.outputFileSync(getLogPath(), '')
  } catch (e) {
    try {
      log.error('[log] 清空日志失败', e)
    } catch {}
  }
}

export function appendPlainLogLineSync(text: string): void {
  try {
    const filePath = getLogPath()
    const line = String(text || '').trim()
    if (!line) return
    fs.ensureFileSync(filePath)
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch (e) {
    log.error('[log] 追加日志失败', e)
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
  } catch {
    return false
  }
}

process.on('uncaughtException', (error) => {
  if (isExpectedError(error)) return
  ensureLogConfigured()
  log.error(error)
})

process.on('unhandledRejection', (reason: unknown, promise) => {
  if (isExpectedError(reason)) return
  ensureLogConfigured()
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
