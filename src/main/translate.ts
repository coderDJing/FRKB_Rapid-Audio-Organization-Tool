import url from './url'
import store from './store'
import fs = require('fs-extra')
import { ILanguageDict } from 'src/types/globals'

export let languageDict: ILanguageDict = {
  enUS: fs.readJSONSync(url.enUsUrl)
}

export function t(str: string, index?: number) {
  if (store.settingConfig.language === 'zhCN' || store.settingConfig.language === '') {
    return str
  }
  const translation = languageDict[store.settingConfig.language]?.[str]
  if (Array.isArray(translation) && index === undefined) {
    index = 0
  }
  // 兜底：若未找到翻译或类型不正确，则直接返回原文，避免打断交互（主进程同样适用）
  if (translation === undefined) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[i18n] Missing translation for "${str}" in ${store.settingConfig.language}; fallback to original`
      )
    } catch (_) {}
    return str
  }
  const returnValue: any = index !== undefined ? (translation as any)[index] : translation
  if (typeof returnValue === 'string') {
    return returnValue
  }
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[i18n] Invalid translation type for "${str}" in ${store.settingConfig.language}; fallback to original`
    )
  } catch (_) {}
  return str
}
