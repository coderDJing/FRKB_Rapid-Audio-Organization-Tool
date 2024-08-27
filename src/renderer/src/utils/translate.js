import { useRuntimeStore } from '@renderer/stores/runtime'
let languageDict = await window.electron.ipcRenderer.invoke('getLanguageDict')
export function t(text) {
  const runtime = useRuntimeStore()
  return languageDict[runtime.setting.language][text]
}

export const translate = {
  t
}
export default translate
