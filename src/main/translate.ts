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
  if (translation === undefined) {
    throw new Error(`语言字典: ${store.settingConfig.language} 未找到"${str}"映射`)
  }
  let returnValue = index !== undefined ? translation[index] : translation
  if (typeof returnValue === 'string') {
    return returnValue
  } else {
    throw new Error(`语言字典: ${store.settingConfig.language} "${str}"映射值类型错误`)
  }
}
