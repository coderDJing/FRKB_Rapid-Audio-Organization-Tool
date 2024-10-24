import { useRuntimeStore } from '@renderer/stores/runtime'
import { ILanguageDict } from 'src/types/globals'

let languageDict: ILanguageDict = {}
async function getLanguageDict() {
  return await window.electron.ipcRenderer.invoke('getLanguageDict')
}
getLanguageDict().then((dict) => {
  languageDict = dict
})

export function t(text: string, index?: number) {
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
  let returnValue = index !== undefined ? translation[index] : translation
  if (typeof returnValue === 'string') {
    return returnValue
  } else {
    throw new Error(`语言字典: ${lang} "${text}"映射值类型错误`)
  }
}

export const translate = {
  t
}
export default translate
