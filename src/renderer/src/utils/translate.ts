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

  // 兜底：若未找到翻译或类型不正确，则直接返回原文，避免打断交互
  if (translation === undefined) {
    try {
      // 轻量告警方便定位缺失 key，但不影响用户操作
      // eslint-disable-next-line no-console
      console.warn(`[i18n] Missing translation for "${text}" in ${lang}; fallback to original`)
    } catch (_) {}
    return text
  }
  const returnValue = index !== undefined ? (translation as any)[index] : translation
  if (typeof returnValue === 'string') {
    return returnValue
  }
  try {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] Invalid translation type for "${text}" in ${lang}; fallback to original`)
  } catch (_) {}
  return text
}

export const translate = {
  t
}
export default translate
