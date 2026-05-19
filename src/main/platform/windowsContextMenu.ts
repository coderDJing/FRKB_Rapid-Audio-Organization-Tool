import { execFile, execFileSync } from 'child_process'
import { app } from 'electron'
import zhCNSettingsLocale from '../../renderer/src/i18n/locales/zh-CN/settings.json'
import enUSSettingsLocale from '../../renderer/src/i18n/locales/en-US/settings.json'
import store from '../store'
import { log } from '../log'
import { persistSettingConfig } from '../settingsPersistence'

const WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH = 'HKCU\\Software\\Classes\\*\\shell\\PlayWithFRKB'

const runRegCommand = (args: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

const quoteCommandArgument = (value: string): string =>
  `"${String(value || '').replace(/"/g, '\\"')}"`

const appendCommandArgument = (args: string[], value: string): void => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return
  args.push(quoteCommandArgument(trimmed))
}

const appendDevEnvArgument = (args: string[], name: string, value: unknown): void => {
  const normalized = String(value || '').trim()
  if (!normalized) return
  appendCommandArgument(args, `${name}=${normalized}`)
}

const resolveDevElectronAppPath = (): string => {
  if (app.isPackaged) return ''
  try {
    const appPath = app.getAppPath()
    return appPath ? appPath : ''
  } catch {
    return ''
  }
}

const appendDevContextMenuArgs = (args: string[]): void => {
  if (app.isPackaged) return
  appendDevEnvArgument(args, '--frkb-dev-instance', process.env.FRKB_DEV_INSTANCE)
  appendDevEnvArgument(args, '--frkb-dev-user-data-dir', process.env.FRKB_DEV_USER_DATA_DIR)
  appendDevEnvArgument(args, '--frkb-dev-database-url', process.env.FRKB_DEV_DATABASE_URL)
  appendDevEnvArgument(args, '--frkb-dev-server-port', process.env.FRKB_DEV_SERVER_PORT)
  appendDevEnvArgument(args, '--frkb-electron-renderer-url', process.env.ELECTRON_RENDERER_URL)
}

const buildWindowsContextMenuCommand = (): string => {
  const args = [quoteCommandArgument(process.execPath)]
  const devAppPath = resolveDevElectronAppPath()
  if (devAppPath) {
    args.push(quoteCommandArgument(devAppPath))
    appendDevContextMenuArgs(args)
  }
  args.push('"%1"')
  return args.join(' ')
}

const getNormalizedExtensions = (): string[] => {
  if (process.platform !== 'win32') return []
  const extensions = Array.isArray(store.settingConfig.audioExt) ? store.settingConfig.audioExt : []
  const normalized = extensions
    .map((ext) => {
      const trimmed = String(ext || '').trim()
      if (!trimmed) return ''
      return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    })
    .filter(Boolean)
  const unique = Array.from(new Set(normalized.map((ext) => ext.toLowerCase())))
  unique.sort()
  return unique
}

const getWindowsContextMenuPaths = (): string[] => {
  return getNormalizedExtensions().map(
    (ext) => `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\PlayWithFRKB`
  )
}

const getWindowsContextMenuCommandPaths = (): string[] => {
  return getWindowsContextMenuPaths().map((p) => `${p}\\command`)
}

const readWindowsRegistryDefaultValue = (regPath: string): string => {
  try {
    const stdout = execFileSync('reg', ['query', regPath, '/ve'], {
      encoding: 'utf8',
      windowsHide: true
    })
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const markerIndex = line.indexOf('REG_SZ')
      if (markerIndex === -1) continue
      return line.slice(markerIndex + 'REG_SZ'.length).trim()
    }
  } catch {}
  return ''
}

const hasExpectedWindowsContextMenuCommand = (expectedCommand: string): boolean => {
  const commandPaths = getWindowsContextMenuCommandPaths()
  if (commandPaths.length === 0) return false
  return commandPaths.every(
    (commandPath) => readWindowsRegistryDefaultValue(commandPath) === expectedCommand
  )
}

const removeLegacyWindowsContextMenu = async (): Promise<void> => {
  if (process.platform !== 'win32') return
  try {
    await runRegCommand(['delete', WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH, '/f'])
  } catch {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getCurrentLocaleId = (): 'zh-CN' | 'en-US' =>
  store.settingConfig?.language === 'enUS' ? 'en-US' : 'zh-CN'

const tContextMenu = (key: string): string => {
  const messages: Record<'zh-CN' | 'en-US', Record<string, unknown>> = {
    'zh-CN': zhCNSettingsLocale as Record<string, unknown>,
    'en-US': enUSSettingsLocale as Record<string, unknown>
  }
  const localeId = getCurrentLocaleId()
  const parts = key.split('.')
  let current: unknown = messages[localeId]
  for (const part of parts) {
    if (isRecord(current) && part in current) current = current[part]
    else return key
  }
  return typeof current === 'string' ? current : key
}

export async function ensureWindowsContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return
  const displayName = tContextMenu('settings.explorerContextMenuLabel')
  const command = buildWindowsContextMenuCommand()
  const shellPaths = getWindowsContextMenuPaths()
  const commandPaths = getWindowsContextMenuCommandPaths()
  await removeLegacyWindowsContextMenu()
  for (let i = 0; i < shellPaths.length; i++) {
    const shellPath = shellPaths[i]
    const commandPath = commandPaths[i]
    try {
      await runRegCommand(['add', shellPath, '/ve', '/d', displayName, '/f'])
      await runRegCommand(['add', shellPath, '/v', 'Icon', '/d', process.execPath, '/f'])
      await runRegCommand(['add', commandPath, '/ve', '/d', command, '/f'])
    } catch (error) {
      log.error('注册 Windows 右键菜单失败', { path: shellPath, error })
    }
  }
}

const buildContextMenuSignature = (): string => {
  if (process.platform !== 'win32') return ''
  const payload = {
    command: buildWindowsContextMenuCommand(),
    execPath: process.execPath || '',
    exts: getNormalizedExtensions(),
    label: tContextMenu('settings.explorerContextMenuLabel')
  }
  return JSON.stringify(payload)
}

export async function ensureWindowsContextMenuIfNeeded(): Promise<void> {
  if (process.platform !== 'win32') return
  const signature = buildContextMenuSignature()
  if (!signature) return
  const stored = String(store.settingConfig.windowsContextMenuSignature || '')
  // 检测翻译是否失败（返回原始 key），如果是则强制更新
  const label = tContextMenu('settings.explorerContextMenuLabel')
  const translationFailed = label === 'settings.explorerContextMenuLabel'
  // 检查注册表项是否真的存在，如果不存在则强制重新注册
  const registryExists = hasWindowsContextMenu()
  const expectedCommand = buildWindowsContextMenuCommand()
  const registryCommandMatches =
    registryExists && hasExpectedWindowsContextMenuCommand(expectedCommand)
  if (stored === signature && !translationFailed && registryCommandMatches) return
  await ensureWindowsContextMenu()
  store.settingConfig.windowsContextMenuSignature = signature
  await persistSettingConfig()
}

export async function removeWindowsContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return
  const shellPaths = getWindowsContextMenuPaths()
  for (const shellPath of shellPaths) {
    try {
      await runRegCommand(['delete', shellPath, '/f'])
    } catch (error) {
      log.error('删除 Windows 右键菜单失败', { path: shellPath, error })
    }
  }
  await removeLegacyWindowsContextMenu()
}

export async function clearWindowsContextMenuSignature(): Promise<void> {
  if (process.platform !== 'win32') return
  if (!('windowsContextMenuSignature' in store.settingConfig)) return
  delete store.settingConfig.windowsContextMenuSignature
  await persistSettingConfig()
}

export function hasWindowsContextMenu(): boolean {
  if (process.platform !== 'win32') return false
  const commandPaths = getWindowsContextMenuCommandPaths()
  for (const commandPath of commandPaths) {
    try {
      execFileSync('reg', ['query', commandPath], { stdio: 'ignore' })
      return true
    } catch {
      continue
    }
  }
  try {
    execFileSync('reg', ['query', `${WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH}\\command`], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}
