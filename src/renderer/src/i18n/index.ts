import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

// 支持的语言列表
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

// 创建i18n实例
export const i18n = createI18n({
  legacy: false, // 使用Composition API模式
  globalInjection: true,
  locale: 'zh-CN', // 默认语言
  fallbackLocale: 'zh-CN', // 回退语言
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  },
  // 开发环境下显示警告
  missingWarn: process.env.NODE_ENV === 'development',
  fallbackWarn: process.env.NODE_ENV === 'development'
})

// 获取当前语言
export function getCurrentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}

// 切换语言
export function setLocale(locale: SupportedLocale) {
  i18n.global.locale.value = locale
}

// 获取翻译函数
export function useTranslation() {
  return i18n.global
}
