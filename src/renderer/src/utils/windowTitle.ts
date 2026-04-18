const resolveDevInstanceId = (): string => {
  try {
    return String(window.api?.getDevRuntimeInfo?.().instanceId || '').trim()
  } catch {
    return ''
  }
}

const devInstanceId = resolveDevInstanceId()

export const formatWindowTitle = (baseTitle: string): string => {
  const resolvedBaseTitle = String(baseTitle || '').trim() || 'FRKB'
  if (!devInstanceId) return resolvedBaseTitle
  return `${resolvedBaseTitle} [dev:${devInstanceId}]`
}
