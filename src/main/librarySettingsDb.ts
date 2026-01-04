import type { ISettingConfig } from '../types/globals'
import store from './store'
import { getLibraryDb, initLibraryDb, getMetaValue, setMetaValue } from './libraryDb'
import { log } from './log'
import { persistSettingConfig } from './settingsPersistence'

type LibrarySettingValues = Pick<
  ISettingConfig,
  'fingerprintMode' | 'audioExt' | 'persistSongFilters'
>

const META_KEYS = {
  fingerprintMode: 'library_setting_fingerprint_mode',
  audioExt: 'library_setting_audio_ext',
  persistSongFilters: 'library_setting_persist_song_filters'
} as const

function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function normalizeFingerprintMode(value: unknown): 'pcm' | 'file' | null {
  if (value === 'pcm' || value === 'file') return value
  return null
}

function normalizeAudioExt(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
}

function normalizePersistSongFilters(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === '1') return true
  if (value === '0') return false
  return null
}

function isArrayEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function readLibrarySettings(db: any): Partial<LibrarySettingValues> {
  const result: Partial<LibrarySettingValues> = {}
  try {
    const modeRaw = getMetaValue(db, META_KEYS.fingerprintMode)
    if (modeRaw) {
      const parsed = parseStoredValue(modeRaw)
      const mode = normalizeFingerprintMode(parsed)
      if (mode) result.fingerprintMode = mode
    }
  } catch {}

  try {
    const audioRaw = getMetaValue(db, META_KEYS.audioExt)
    if (audioRaw) {
      const parsed = parseStoredValue(audioRaw)
      const list = normalizeAudioExt(parsed)
      if (list !== null) result.audioExt = list
    }
  } catch {}

  try {
    const persistRaw = getMetaValue(db, META_KEYS.persistSongFilters)
    if (persistRaw) {
      const parsed = parseStoredValue(persistRaw)
      const flag = normalizePersistSongFilters(parsed)
      if (flag !== null) result.persistSongFilters = flag
    }
  } catch {}

  return result
}

function writeLibrarySettings(db: any, values: Partial<LibrarySettingValues>): void {
  try {
    if (values.fingerprintMode) {
      setMetaValue(db, META_KEYS.fingerprintMode, JSON.stringify(values.fingerprintMode))
    }
    if (Array.isArray(values.audioExt)) {
      setMetaValue(db, META_KEYS.audioExt, JSON.stringify(values.audioExt))
    }
    if (typeof values.persistSongFilters === 'boolean') {
      setMetaValue(db, META_KEYS.persistSongFilters, JSON.stringify(values.persistSongFilters))
    }
  } catch {}
}

function getDbForCurrentLibrary(): any | null {
  const root = store.databaseDir
  if (!root) return null
  if (store.settingConfig?.databaseUrl && store.settingConfig.databaseUrl !== root) return null
  return initLibraryDb(root)
}

export async function syncLibrarySettingsFromDb(dirPath?: string): Promise<void> {
  const db = dirPath ? initLibraryDb(dirPath) : getLibraryDb()
  if (!db) return
  const current = store.settingConfig || ({} as ISettingConfig)
  const dbValues = readLibrarySettings(db)
  const toWrite: Partial<LibrarySettingValues> = {}
  let changed = false

  const currentMode = normalizeFingerprintMode(current.fingerprintMode)
  if (dbValues.fingerprintMode) {
    if (currentMode !== dbValues.fingerprintMode) {
      current.fingerprintMode = dbValues.fingerprintMode
      changed = true
    }
  } else if (currentMode) {
    toWrite.fingerprintMode = currentMode
  }

  const currentAudio = normalizeAudioExt(current.audioExt)
  if (dbValues.audioExt !== undefined) {
    if (!isArrayEqual(currentAudio, dbValues.audioExt || [])) {
      current.audioExt = dbValues.audioExt || []
      changed = true
    }
  } else if (currentAudio !== null) {
    toWrite.audioExt = currentAudio
  }

  const currentPersist = normalizePersistSongFilters(current.persistSongFilters)
  if (dbValues.persistSongFilters !== undefined) {
    if (currentPersist !== dbValues.persistSongFilters) {
      current.persistSongFilters = !!dbValues.persistSongFilters
      changed = true
    }
  } else if (currentPersist !== null) {
    toWrite.persistSongFilters = currentPersist
  }

  if (Object.keys(toWrite).length > 0) {
    writeLibrarySettings(db, toWrite)
  }

  if (changed) {
    try {
      store.settingConfig = current
      await persistSettingConfig(current)
    } catch (error) {
      log.error('[library-settings] persist config failed', error)
    }
  }
}

export async function saveLibrarySettingsFromConfig(): Promise<void> {
  const db = getDbForCurrentLibrary()
  if (!db) return
  const current = store.settingConfig || ({} as ISettingConfig)
  const mode = normalizeFingerprintMode(current.fingerprintMode)
  const audio = normalizeAudioExt(current.audioExt)
  const persist = normalizePersistSongFilters(current.persistSongFilters)
  writeLibrarySettings(db, {
    fingerprintMode: mode || undefined,
    audioExt: audio !== null ? audio : undefined,
    persistSongFilters: persist !== null ? persist : undefined
  })
}

export default {
  syncLibrarySettingsFromDb,
  saveLibrarySettingsFromConfig
}
