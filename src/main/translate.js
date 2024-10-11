import url from './url.js'
import store from './store.js'
const fs = require('fs-extra')

let enUS = fs.readJSONSync(url.enUsUrl)
export let languageDict = {
  enUS
}

export function t(str) {
  return languageDict[store.settingConfig.language][str]
}
