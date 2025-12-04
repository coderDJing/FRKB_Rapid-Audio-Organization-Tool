import { execFile, execFileSync } from 'child_process'
import store from '../store'
import { log } from '../log'

const WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH = 'HKCU\\Software\\Classes\\*\\shell\\PlayWithFRKB'

const runRegCommand = (args: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

const getWindowsContextMenuPaths = (): string[] => {
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
  return unique.map(
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

export async function ensureWindowsContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return
  const displayName = '在 FRKB 中播放'
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
