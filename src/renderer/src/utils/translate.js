import { useRuntimeStore } from '@renderer/stores/runtime'
let languageDict = await window.electron.ipcRenderer.invoke('getLanguageDict')
export function t(text) {
  const runtime = useRuntimeStore()
  if (languageDict[runtime.setting.language][text] === undefined) {
    throw new Error('语言字典:' + runtime.setting.language + '未找到"' + text + '"映射')
  }
  return languageDict[runtime.setting.language][text]
}

export const translate = {
  t
}
export default translate
