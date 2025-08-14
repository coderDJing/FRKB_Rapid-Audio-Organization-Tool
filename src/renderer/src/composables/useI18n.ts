import { useI18n as useVueI18n } from 'vue-i18n'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { setLocale, type SupportedLocale } from '@renderer/i18n'

/**
 * 自定义i18n组合式函数
 * 提供翻译功能和语言切换功能
 */
export function useI18n() {
  const { t: translate, locale } = useVueI18n()
  const runtime = useRuntimeStore()

  /**
   * 翻译函数
   * @param key 翻译键名
   * @param interpolations 插值参数
   * @param options 选项
   */
  const t = (key: string, interpolations?: Record<string, any>, options?: any) => {
    if (interpolations) {
      return translate(key, interpolations, options)
    }
    return translate(key, options)
  }

  /**
   * 切换语言
   * @param newLocale 新语言代码
   */
  const switchLanguage = async (newLocale: SupportedLocale) => {
    setLocale(newLocale)
    // 同步更新到runtime store和设置
    const langCode = newLocale === 'zh-CN' ? '' : 'enUS'
    if (runtime.setting.language !== langCode) {
      runtime.setting.language = langCode
      await window.electron.ipcRenderer.invoke('setSetting', runtime.setting)
    }
  }

  return {
    t,
    locale,
    switchLanguage
  }
}
