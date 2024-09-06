import url from './url.js'
import store from './store.js'
const fs = require('fs-extra')

let enUS = fs.readJSONSync(url.enUsUrl)
let zhCN = fs.readJSONSync(url.zhCNUrl)
export let languageDict = {
  enUS,
  zhCN
}

export function t(str) {
  return languageDict[store.settingConfig.language][str]
}
