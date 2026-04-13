import fs = require('fs-extra')
import type { ILayoutConfig } from 'src/types/globals'
import { log } from './log'
import url from './url'
import {
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_SIZE_MIGRATIONS,
  defaultLayoutConfig
} from './layoutConfigDefaults'

export {
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_DEFAULT_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  defaultLayoutConfig
} from './layoutConfigDefaults'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toNonNegativeInteger = (value: unknown, fallback: number) => {
  const parsed = Math.floor(toFiniteNumber(value, fallback))
  return parsed >= 0 ? parsed : fallback
}

export function normalizeLayoutConfig(value: unknown): ILayoutConfig {
  const raw = isRecord(value) ? value : {}
  const merged = {
    ...defaultLayoutConfig,
    ...raw
  }

  let mainWindowWidth = Math.max(
    100,
    Math.round(toFiniteNumber(merged.mainWindowWidth, defaultLayoutConfig.mainWindowWidth))
  )
  let mainWindowHeight = Math.max(
    100,
    Math.round(toFiniteNumber(merged.mainWindowHeight, defaultLayoutConfig.mainWindowHeight))
  )
  let mainWindowSizeMigrationVersion = toNonNegativeInteger(
    merged.mainWindowSizeMigrationVersion,
    0
  )

  for (const migration of MAIN_WINDOW_SIZE_MIGRATIONS) {
    if (mainWindowSizeMigrationVersion >= migration.version) continue
    mainWindowWidth = Math.max(mainWindowWidth, migration.minWidth)
    mainWindowHeight = Math.max(mainWindowHeight, migration.minHeight)
    mainWindowSizeMigrationVersion = migration.version
  }

  return {
    libraryAreaWidth: Math.max(
      0,
      Math.round(toFiniteNumber(merged.libraryAreaWidth, defaultLayoutConfig.libraryAreaWidth))
    ),
    isMaxMainWin: !!merged.isMaxMainWin,
    mainWindowWidth: Math.max(mainWindowWidth, MAIN_WINDOW_MIN_WIDTH),
    mainWindowHeight: Math.max(mainWindowHeight, MAIN_WINDOW_MIN_HEIGHT),
    mainWindowSizeMigrationVersion
  }
}

export function mergeLayoutConfig(current: ILayoutConfig, patch: unknown): ILayoutConfig {
  const safePatch = isRecord(patch) ? patch : {}
  return normalizeLayoutConfig({
    ...current,
    ...safePatch
  })
}

export function loadLayoutConfigSync(): ILayoutConfig {
  let loaded: unknown = defaultLayoutConfig
  if (fs.pathExistsSync(url.layoutConfigFileUrl)) {
    try {
      loaded = fs.readJSONSync(url.layoutConfigFileUrl)
    } catch (error) {
      log.error('[layoutConfig] 读取布局配置失败，将回退默认配置', error)
    }
  }
  const finalConfig = normalizeLayoutConfig(loaded)
  fs.outputJsonSync(url.layoutConfigFileUrl, finalConfig)
  return finalConfig
}

export async function persistLayoutConfig(config: unknown): Promise<ILayoutConfig> {
  const finalConfig = normalizeLayoutConfig(config)
  await fs.outputJson(url.layoutConfigFileUrl, finalConfig)
  return finalConfig
}

export function persistLayoutConfigSync(config: unknown): ILayoutConfig {
  const finalConfig = normalizeLayoutConfig(config)
  fs.outputJsonSync(url.layoutConfigFileUrl, finalConfig)
  return finalConfig
}
