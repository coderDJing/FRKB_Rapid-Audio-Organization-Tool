import fs = require('fs-extra')
import store from './store'
import url from './url'
import type { ISettingConfig } from '../types/globals'
import { UI_SETTING_KEYS } from '../shared/uiSettings'

export function stripUiSettings<T>(setting: T): T {
  const next = { ...(setting as any) }
  for (const key of UI_SETTING_KEYS) {
    if (key in next) delete next[key]
  }
  return next as T
}

export async function persistSettingConfig(setting?: ISettingConfig): Promise<void> {
  const target = stripUiSettings((setting ?? store.settingConfig) as ISettingConfig)
  await fs.outputJson(url.settingConfigFileUrl, target)
}

export function persistSettingConfigSync(setting?: ISettingConfig): void {
  const target = stripUiSettings((setting ?? store.settingConfig) as ISettingConfig)
  fs.outputJsonSync(url.settingConfigFileUrl, target)
}
