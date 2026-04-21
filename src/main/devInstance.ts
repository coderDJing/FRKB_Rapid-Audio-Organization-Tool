import { app } from 'electron'
import { spawnSync } from 'node:child_process'
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
  lockFilePath: string
  ownerPid: number
  release: () => void
}

type DevLockFile = {
  pid: number
  createdAtMs: number
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

const parsePositiveInteger = (value: unknown): number => {
  const parsed = Number(value || 0)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

const readLockFile = (lockFilePath: string): DevLockFile => {
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { pid: 0, createdAtMs: 0 }
    }
    const record = parsed as Record<string, unknown>
    const createdAt = typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : 0
    return {
      pid: parsePositiveInteger(record.pid),
      createdAtMs: Number.isFinite(createdAt) ? createdAt : 0
    }
  } catch {
    return { pid: 0, createdAtMs: 0 }
  }
}

const readProcessStartTimeMs = (pid: number): number => {
  if (!Number.isInteger(pid) || pid <= 0) return 0

  if (process.platform === 'win32') {
    const command = [
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
      'if ($process) { $process.CreationDate.ToUniversalTime().ToString("o") }'
    ].join('; ')
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      }
    )
    const createdAt =
      String(result.stdout || '')
        .trim()
        .split(/\r?\n/)[0] || ''
    const parsed = Date.parse(createdAt)
    return Number.isFinite(parsed) ? parsed : 0
  }

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true
  })
  const startedAt = String(result.stdout || '').trim()
  const parsed = Date.parse(startedAt)
  return Number.isFinite(parsed) ? parsed : 0
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

const isLockOwnerAlive = (lockFile: DevLockFile): boolean => {
  if (!isProcessAlive(lockFile.pid)) return false

  const processStartTimeMs = readProcessStartTimeMs(lockFile.pid)
  if (!processStartTimeMs || !lockFile.createdAtMs) return true

  return processStartTimeMs <= lockFile.createdAtMs + 5000
}

const removeLockFileIfOwned = (lockFilePath: string) => {
  try {
    if (!fs.pathExistsSync(lockFilePath)) return
    if (readLockFile(lockFilePath).pid !== process.pid) return
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
        lockFilePath,
        ownerPid: process.pid,
        release
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
      if (code !== 'EEXIST') {
        log.error('[dev] 创建实例锁失败，继续沿用多开模式', error)
        return {
          isPrimaryInstance: true,
          lockFilePath,
          ownerPid: process.pid,
          release: () => {}
        }
      }

      const lockFile = readLockFile(lockFilePath)
      if (isLockOwnerAlive(lockFile)) {
        return {
          isPrimaryInstance: false,
          lockFilePath,
          ownerPid: lockFile.pid,
          release: () => {}
        }
      }

      try {
        fs.removeSync(lockFilePath)
      } catch (removeError) {
        log.error('[dev] 清理失效实例锁失败', removeError)
        return {
          isPrimaryInstance: false,
          lockFilePath,
          ownerPid: lockFile.pid,
          release: () => {}
        }
      }
    }
  }
}
