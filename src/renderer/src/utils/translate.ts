import { i18n } from '@renderer/i18n'

// 核心库中文名 -> i18n key 的集中映射
export const LIBRARY_NAME_TO_I18N_KEY: Record<string, string> = {
  筛选库: 'library.filter',
  精选库: 'library.curated',
  回收站: 'recycleBin.recycleBin'
}

// 仅用于将核心库名转为展示文本（遵循正常 i18n）
export function toLibraryDisplayName(libraryName: string): string {
  const key = LIBRARY_NAME_TO_I18N_KEY[libraryName]
  return key ? t(key) : libraryName
}

// 兼容旧调用：导出同名 t()，内部使用 vue-i18n
export function t(text: string, index?: number): string
export function t(text: string, values?: Record<string, any>): string
export function t(text: string, valuesOrIndex?: number | Record<string, any>): string {
  try {
    // 若传入的不是命名空间 key（不包含'.'），直接返回原文，避免触发缺失 key 警告
    const looksLikeKey = (val: string) => val.includes('.')
    if (!looksLikeKey(text)) return text

    // 访问 locale 以建立对语言的响应式依赖，切换语言时触发重渲染
    const localeRef: any = (i18n.global as any).locale
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    typeof localeRef === 'object' ? localeRef.value : localeRef

    const i18nT = i18n.global.t as any
    const translated =
      valuesOrIndex && typeof valuesOrIndex === 'object' ? i18nT(text, valuesOrIndex) : i18nT(text)

    // 若未命中 key（vue-i18n 会回传 key 本身），保持原文
    if (translated === text) return text
    return translated
  } catch (_) {
    return text
  }
}

export const translate = { t }
export default translate
