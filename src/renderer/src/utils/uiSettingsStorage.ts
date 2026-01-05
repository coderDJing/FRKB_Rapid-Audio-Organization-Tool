import { watch, toRaw } from 'vue'
import type { ISettingConfig } from 'src/types/globals'
import { UI_SETTING_KEYS, type UiSettingKey } from '../../../shared/uiSettings'

const STORAGE_KEY = 'frkb_ui_settings_v1'
const MIGRATION_KEY = 'frkb_ui_settings_migrated_v1'

type UiSettings = Partial<Record<UiSettingKey, unknown>>

const getStorage = (): Storage | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 1) return true
  if (value === '0' || value === 0) return false
  return undefined
}

const normalizeNumber = (value: unknown): number | undefined => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : undefined
}

const normalizeString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const sanitizeUiSettings = (input: Record<string, unknown>): UiSettings => {
  const output: UiSettings = {}
  for (const key of UI_SETTING_KEYS) {
    const value = input[key]
    switch (key) {
      case 'hiddenPlayControlArea':
      case 'autoPlayNextSong':
      case 'enablePlaybackRange':
      case 'autoScrollToCurrentSong':
      case 'showPlaylistTrackCount':
      case 'songListBubbleAlways': {
        const v = normalizeBoolean(value)
        if (v !== undefined) output[key] = v
        break
      }
      case 'waveformStyle': {
        const normalized = value === 'Mixxx' || value === 'RekordboxMini' ? 'RGB' : value
        if (normalized === 'SoundCloud' || normalized === 'Fine' || normalized === 'RGB') {
          output[key] = normalized
        }
        break
      }
      case 'waveformMode':
        if (value === 'half' || value === 'full') {
          output[key] = value
        }
        break
      case 'startPlayPercent':
      case 'endPlayPercent':
      case 'fastForwardTime':
      case 'fastBackwardTime': {
        const v = normalizeNumber(value)
        if (v !== undefined) output[key] = v
        break
      }
      case 'recentDialogSelectedSongListMaxCount': {
        const v = normalizeNumber(value)
        if (v !== undefined) output[key] = Math.max(0, Math.floor(v))
        break
      }
      case 'audioOutputDeviceId': {
        const v = normalizeString(value)
        if (v !== undefined) output[key] = v
        break
      }
    }
  }
  return output
}

export const readUiSettings = (): UiSettings => {
  const storage = getStorage()
  if (!storage) return {}
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed)) return {}
    return sanitizeUiSettings(parsed)
  } catch {
    return {}
  }
}

export const writeUiSettings = (next: Record<string, unknown>): void => {
  const storage = getStorage()
  if (!storage) return
  const existing = readUiSettings()
  const incoming = isPlainObject(next) ? sanitizeUiSettings(next) : {}
  const merged = { ...existing, ...incoming }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {}
}

export const pickUiSettings = (setting: Record<string, unknown>): UiSettings => {
  const raw: Record<string, unknown> = {}
  if (!setting || typeof setting !== 'object') return {}
  for (const key of UI_SETTING_KEYS) {
    if (key in setting) raw[key] = (setting as Record<string, unknown>)[key]
  }
  return sanitizeUiSettings(raw)
}

export const applyUiSettings = (setting: Record<string, unknown>, ui: UiSettings): void => {
  if (!setting || typeof setting !== 'object') return
  for (const key of UI_SETTING_KEYS) {
    if (ui[key] !== undefined) {
      ;(setting as Record<string, unknown>)[key] = ui[key]
    }
  }
}

const toPlainSetting = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(toRaw(value))) as T
  } catch {
    return value
  }
}

export const stripUiSettings = (setting: ISettingConfig): ISettingConfig => {
  const raw = toRaw(setting) as unknown as Record<string, unknown>
  const next = { ...raw } as Record<string, unknown>
  for (const key of UI_SETTING_KEYS) {
    if (key in next) delete next[key]
  }
  return next as unknown as ISettingConfig
}

export const initUiSettings = (
  setting: ISettingConfig
): { cleanedSetting: ISettingConfig; needsCleanup: boolean } => {
  const storage = getStorage()
  if (!storage) {
    return { cleanedSetting: stripUiSettings(setting), needsCleanup: false }
  }
  const fromConfig = pickUiSettings(setting as unknown as Record<string, unknown>)
  const stored = readUiSettings()
  const merged = { ...fromConfig, ...stored }
  if (Object.keys(merged).length > 0) {
    writeUiSettings(merged)
  }
  applyUiSettings(setting as unknown as Record<string, unknown>, merged)
  const migrated = storage.getItem(MIGRATION_KEY) === '1'
  if (!migrated) {
    try {
      storage.setItem(MIGRATION_KEY, '1')
    } catch {}
  }
  const cleanedSetting = toPlainSetting(stripUiSettings(setting))
  return { cleanedSetting, needsCleanup: !migrated }
}

export const watchUiSettings = (setting: ISettingConfig): void => {
  try {
    watch(
      () => pickUiSettings(setting as unknown as Record<string, unknown>),
      (next) => writeUiSettings(next as unknown as Record<string, unknown>),
      { deep: true }
    )
  } catch {}
}
