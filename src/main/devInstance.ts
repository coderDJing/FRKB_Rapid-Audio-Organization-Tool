import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'

type LoggerLike = {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

type DevRuntimeConfig = {
  instanceId: string
  userDataDir: string
  databaseDir: string
  usesIsolatedUserData: boolean
  usesCustomSingleInstanceLock: boolean
}

type DevSingleInstanceLock = {
  isPrimaryInstance: boolean
  release: () => void
}

const DEV_INSTANCE_ENV = 'FRKB_DEV_INSTANCE'
const DEV_USER_DATA_ENV = 'FRKB_DEV_USER_DATA_DIR'
const DEV_DATABASE_ENV = 'FRKB_DEV_DATABASE_URL'

const sanitizeInstanceId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

const normalizeDirectoryOverride = (value: string): string => {
  const normalized = value.trim()
  if (!normalized) return ''
  return path.resolve(normalized)
}

const readLockPid = (lockFilePath: string): number => {
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown }
    const pid = Number(parsed.pid || 0)
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
    return code === 'EPERM'
  }
}

const removeLockFileIfOwned = (lockFilePath: string) => {
  try {
    if (!fs.pathExistsSync(lockFilePath)) return
    if (readLockPid(lockFilePath) !== process.pid) return
    fs.removeSync(lockFilePath)
  } catch {}
}

export const getDevInstanceId = (): string =>
  sanitizeInstanceId(String(process.env[DEV_INSTANCE_ENV] || ''))

export const configureDevRuntime = (
  isDev: boolean,
  platform: NodeJS.Platform,
  log: LoggerLike
): DevRuntimeConfig | null => {
  if (!isDev) return null

  const instanceId = getDevInstanceId()
  const configuredUserDataDir = normalizeDirectoryOverride(
    String(process.env[DEV_USER_DATA_ENV] || '')
  )
  const usesIsolatedUserData = !!instanceId || !!configuredUserDataDir
  const userDataFolder = instanceId ? `frkb-dev-${instanceId}` : 'frkb-dev'
  let userDataDir = ''

  try {
    userDataDir = configuredUserDataDir || path.join(app.getPath('appData'), userDataFolder)
    app.setPath('userData', userDataDir)
    app.setPath('sessionData', path.join(userDataDir, 'session'))
  } catch (error) {
    log.error('[dev] 设置隔离用户目录失败', error)
    try {
      userDataDir = app.getPath('userData')
    } catch {
      userDataDir = ''
    }
  }

  const configuredDatabaseDir = normalizeDirectoryOverride(
    String(process.env[DEV_DATABASE_ENV] || '')
  )
  const databaseDir = platform === 'win32' ? configuredDatabaseDir : ''

  if (instanceId) {
    process.env[DEV_INSTANCE_ENV] = instanceId
  }
  if (configuredUserDataDir) {
    process.env[DEV_USER_DATA_ENV] = configuredUserDataDir
  }
  if (databaseDir) {
    process.env[DEV_DATABASE_ENV] = databaseDir
  }

  return {
    instanceId,
    userDataDir,
    databaseDir,
    usesIsolatedUserData,
    usesCustomSingleInstanceLock: usesIsolatedUserData
  }
}

export const acquireDevSingleInstanceLock = (
  runtime: DevRuntimeConfig | null,
  log: LoggerLike
): DevSingleInstanceLock | null => {
  if (!runtime?.usesCustomSingleInstanceLock || !runtime.userDataDir) return null

  const lockFilePath = path.join(runtime.userDataDir, 'locks', 'single-instance.json')

  while (true) {
    try {
      fs.ensureDirSync(path.dirname(lockFilePath))
      fs.writeFileSync(
        lockFilePath,
        JSON.stringify(
          {
            pid: process.pid,
            instanceId: runtime.instanceId,
            createdAt: new Date().toISOString()
          },
          null,
          2
        ),
        { flag: 'wx' }
      )
      const release = () => removeLockFileIfOwned(lockFilePath)
      return {
        isPrimaryInstance: true,
        release
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
      if (code !== 'EEXIST') {
        log.error('[dev] 创建实例锁失败，继续沿用多开模式', error)
        return {
          isPrimaryInstance: true,
          release: () => {}
        }
      }

      const currentPid = readLockPid(lockFilePath)
      if (isProcessAlive(currentPid)) {
        return {
          isPrimaryInstance: false,
          release: () => {}
        }
      }

      try {
        fs.removeSync(lockFilePath)
      } catch (removeError) {
        log.error('[dev] 清理失效实例锁失败', removeError)
        return {
          isPrimaryInstance: false,
          release: () => {}
        }
      }
    }
  }
}
