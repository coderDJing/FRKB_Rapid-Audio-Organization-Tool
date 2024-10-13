import { useRuntimeStore } from '@renderer/stores/runtime'
let languageDict = await window.electron.ipcRenderer.invoke('getLanguageDict')
export function t(text, index) {
  const runtime = useRuntimeStore()
  const lang = runtime.setting.language
  if (lang === 'zhCN' || lang === '') {
    return text
  }
  const translation = languageDict[lang]?.[text]
  if (Array.isArray(translation) && index === undefined) {
    index = 0
  }

  if (translation === undefined) {
    throw new Error(`语言字典: ${lang} 未找到"${text}"映射`)
  }

  return index !== undefined ? translation[index] : translation
}

export const translate = {
  t
}
export default translate
