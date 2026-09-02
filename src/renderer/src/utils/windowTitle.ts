import { PRODUCT_DISPLAY_NAME } from '@shared/productBrand'

const resolveDevInstanceId = (): string => {
  try {
    return String(window.api?.getDevRuntimeInfo?.().instanceId || '').trim()
  } catch {
    return ''
  }
}

const devInstanceId = resolveDevInstanceId()

export const formatWindowTitle = (baseTitle: string): string => {
  const resolvedBaseTitle = String(baseTitle || '').trim() || PRODUCT_DISPLAY_NAME
  if (!devInstanceId) return resolvedBaseTitle
  return `${resolvedBaseTitle} [dev:${devInstanceId}]`
}
