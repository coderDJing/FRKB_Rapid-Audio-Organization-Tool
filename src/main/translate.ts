import url from './url'
import store from './store'
import fs = require('fs-extra')

export let languageDict = {
  enUS: fs.readJSONSync(url.enUsUrl)
}

export function t(str: string, index: number | undefined) {
  if (store.settingConfig.language === 'zhCN' || store.settingConfig.language === '') {
    return str
  }
  const translation = languageDict[store.settingConfig.language]?.[str]
  if (Array.isArray(translation) && index === undefined) {
    index = 0
  }
  if (translation === undefined) {
    throw new Error(`语言字典: ${store.settingConfig.language} 未找到"${str}"映射`)
  }
  return index !== undefined ? translation[index] : translation
}
