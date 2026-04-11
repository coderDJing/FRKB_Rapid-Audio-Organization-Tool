import { execFile, execFileSync } from 'child_process'
import zhCNLocale from '../../renderer/src/i18n/locales/zh-CN.json'
import enUSLocale from '../../renderer/src/i18n/locales/en-US.json'
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
    'zh-CN': zhCNLocale as Record<string, unknown>,
    'en-US': enUSLocale as Record<string, unknown>
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
  const command = `"${process.execPath.replace(/"/g, '\\"')}" "%1"`
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
  if (stored === signature) return
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
