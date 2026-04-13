import path = require('path')
import fs = require('fs-extra')

type ElectronAppLike = {
  isPackaged?: boolean
  getVersion?: () => string
  getPath?: (name: string) => string
}

type LogTransportFileLike = {
  level?: string
  format?: string
  maxSize?: number
  resolvePathFn?: () => string
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
    const dynamicRequire = Function('return require')() as NodeRequire
    return dynamicRequire(id)
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
  (safeRequire('electron-log') as Partial<LoggerLike> | null | undefined) || null

export const log: LoggerLike =
  loadedElectronLog &&
  typeof loadedElectronLog.debug === 'function' &&
  typeof loadedElectronLog.info === 'function' &&
  typeof loadedElectronLog.warn === 'function' &&
  typeof loadedElectronLog.error === 'function'
    ? ({
        ...loadedElectronLog,
        transports: {
          file: loadedElectronLog.transports?.file || {}
        }
      } as LoggerLike)
    : createConsoleLogger()

const isPackagedRuntime = (() => {
  try {
    return !!(electronApp && typeof electronApp.isPackaged === 'boolean' && electronApp.isPackaged)
  } catch {
    return false
  }
})()

const isDevRuntime = (() => {
  if (String(process.env.NODE_ENV || '').trim() === 'development') return true
  if (String(process.env.VITE_DEV_SERVER_URL || '').trim()) return true
  return !isPackagedRuntime
})()

const resolveUserDataDir = () => {
  if (!isPackagedRuntime) return __dirname
  try {
    const resolved = electronApp?.getPath?.('userData')
    return typeof resolved === 'string' && resolved.trim() ? resolved : __dirname
  } catch {
    return __dirname
  }
}

const appVersion = (() => {
  try {
    const resolved = electronApp?.getVersion?.()
    return typeof resolved === 'string' && resolved.trim() ? resolved : 'unknown'
  } catch {
    return 'unknown'
  }
})()

log.transports.file.level = 'debug'
log.transports.file.format = `{y}-{m}-{d} {h}:{i}:{s}.{ms} [v${appVersion}] {text}`
log.transports.file.maxSize = 20 * 1024 * 1024
log.transports.file.resolvePathFn = () => {
  if (isDevRuntime) {
    return path.join(process.cwd(), 'log.txt')
  }
  return path.join(resolveUserDataDir(), 'log.txt')
}

export function getLogPath(): string {
  if (isDevRuntime) {
    return path.join(process.cwd(), 'log.txt')
  }
  return path.join(resolveUserDataDir(), 'log.txt')
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
  log.error(error)
})

process.on('unhandledRejection', (reason: unknown, promise) => {
  if (isExpectedError(reason)) return
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
