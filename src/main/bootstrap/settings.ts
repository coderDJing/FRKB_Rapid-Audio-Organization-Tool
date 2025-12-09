import { nativeTheme } from 'electron'
import { is } from '@electron-toolkit/utils'
import { log } from '../log'
import store from '../store'
import url from '../url'
import mainWindow from '../window/mainWindow'
import type { IPlayerGlobalShortcuts, ISettingConfig } from '../../types/globals'
import fs = require('fs-extra')

const platform = process.platform

const defaultConvertDefaults: NonNullable<ISettingConfig['convertDefaults']> = {
  targetFormat: 'mp3',
  bitrateKbps: 320,
  sampleRate: 44100,
  channels: 2,
  preserveMetadata: true,
  normalize: false,
  strategy: 'new_file',
  overwrite: false,
  backupOnReplace: true,
  addFingerprint: false
}

const defaultPlayerGlobalShortcuts: IPlayerGlobalShortcuts = {
  fastForward: 'Shift+Alt+Right',
  fastBackward: 'Shift+Alt+Left',
  nextSong: 'Shift+Alt+Down',
  previousSong: 'Shift+Alt+Up'
}

const defaultSettings = {
  platform: (platform === 'darwin' ? 'darwin' : 'win32') as 'darwin' | 'win32',
  language: (is.dev ? 'zhCN' : '') as '' | 'enUS' | 'zhCN',
  themeMode: 'system' as 'system' | 'light' | 'dark',
  audioExt: [
    '.mp3',
    '.wav',
    '.flac',
    '.aif',
    '.aiff',
    '.ogg',
    '.opus',
    '.aac',
    '.m4a',
    '.mp4',
    '.wma',
    '.ac3',
    '.dts',
    '.mka',
    '.webm',
    '.ape',
    '.tak',
    '.tta',
    '.wv'
  ],
  databaseUrl: '',
  globalCallShortcut:
    platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
  playerGlobalShortcuts: { ...defaultPlayerGlobalShortcuts },
  hiddenPlayControlArea: false,
  waveformStyle: 'SoundCloud' as 'SoundCloud' | 'Fine' | 'RGB' | 'RekordboxMini',
  waveformMode: 'half',
  autoPlayNextSong: false,
  startPlayPercent: 0,
  endPlayPercent: 100,
  fastForwardTime: 10,
  fastBackwardTime: -5,
  autoScrollToCurrentSong: true,
  enablePlaybackRange: false,
  recentDialogSelectedSongListMaxCount: 10,
  audioOutputDeviceId: '',
  persistSongFilters: false,
  enableExplorerContextMenu: platform === 'win32',
  showPlaylistTrackCount: true,
  nextCheckUpdateTime: '',
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1,
  fingerprintMode: 'pcm' as 'pcm',
  cloudSyncUserKey: '',
  convertDefaults: defaultConvertDefaults,
  lastSeenWhatsNewVersion: '',
  pendingWhatsNewForVersion: '',
  acoustIdClientKey: ''
} as ISettingConfig

type LoadSettingsOptions = {
  getWindowsContextMenuStatus: () => boolean
}

export function loadInitialSettings(options: LoadSettingsOptions): ISettingConfig {
  const { getWindowsContextMenuStatus } = options
  const settingFileExisted = fs.pathExistsSync(url.settingConfigFileUrl)

  let loadedSettings: Partial<ISettingConfig> = {}
  if (settingFileExisted) {
    try {
      loadedSettings = fs.readJSONSync(url.settingConfigFileUrl)
    } catch (error) {
      log.error('读取设置文件错误，将使用默认设置:', error)
      loadedSettings = {}
    }
  } else {
    loadedSettings = defaultSettings
  }

  const mergedSettings = {
    ...defaultSettings,
    ...loadedSettings
  }
  const sanitizeShortcut = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value : fallback
  const sanitizePlayerShortcuts = (
    value: Partial<IPlayerGlobalShortcuts> | undefined
  ): IPlayerGlobalShortcuts => {
    const base = { ...defaultPlayerGlobalShortcuts }
    if (!value || typeof value !== 'object') {
      return base
    }
    return {
      fastForward: sanitizeShortcut(value.fastForward, base.fastForward),
      fastBackward: sanitizeShortcut(value.fastBackward, base.fastBackward),
      nextSong: sanitizeShortcut(value.nextSong, base.nextSong),
      previousSong: sanitizeShortcut(value.previousSong, base.previousSong)
    }
  }
  mergedSettings.playerGlobalShortcuts = sanitizePlayerShortcuts(
    (mergedSettings as any).playerGlobalShortcuts
  )

  const finalSettings: ISettingConfig = {
    ...mergedSettings,
    waveformMode: mergedSettings.waveformMode === 'full' ? 'full' : 'half'
  }

  if (process.platform === 'win32') {
    if (typeof (finalSettings as any).enableExplorerContextMenu !== 'boolean') {
      ;(finalSettings as any).enableExplorerContextMenu = settingFileExisted
        ? getWindowsContextMenuStatus()
        : true
    }
  } else {
    ;(finalSettings as any).enableExplorerContextMenu = false
  }

  if (typeof finalSettings.acoustIdClientKey !== 'string') {
    finalSettings.acoustIdClientKey = ''
  }

  try {
    const migrated = (loadedSettings as any)?.migratedAudioExtAll === true
    if (!migrated) {
      const arr = Array.isArray((finalSettings as any).audioExt)
        ? ((finalSettings as any).audioExt as string[])
        : []
      const set = new Set(arr.map((e) => String(e || '').toLowerCase()))
      const allFormats = defaultSettings.audioExt
      let changed = false
      for (const fmt of allFormats) {
        if (!set.has(fmt.toLowerCase())) {
          arr.push(fmt)
          changed = true
        }
      }
      if (changed) {
        ;(finalSettings as any).audioExt = arr
        ;(finalSettings as any).migratedAudioExtAll = true
      }
    }
  } catch {
    // ignore migration failure
  }

  store.settingConfig = finalSettings
  fs.outputJsonSync(url.settingConfigFileUrl, finalSettings)
  return finalSettings
}

export function applyThemeFromSettings() {
  try {
    const mode = ((store as any).settingConfig?.themeMode || 'system') as
      | 'system'
      | 'light'
      | 'dark'
    nativeTheme.themeSource = mode
  } catch {}
}

export function broadcastSystemThemeIfNeeded() {
  try {
    const mode = ((store as any).settingConfig?.themeMode || 'system') as
      | 'system'
      | 'light'
      | 'dark'
    if (mode === 'system' && mainWindow.instance) {
      mainWindow.instance.webContents.send('theme/system-updated', {
        isDark: nativeTheme.shouldUseDarkColors
      })
    }
  } catch {}
}
