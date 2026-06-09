export const WINDOW_SCREENSHOT_SHORTCUT = 'F9'

const isRcVersion = (version: string): boolean =>
  /-rc(?:[.-]|$)/i.test(String(version || '').trim())

export const isWindowScreenshotFeatureAvailable = (params: {
  platform: string
  isDev: boolean
  version: string
}): boolean => {
  return params.platform === 'win32' && (params.isDev || isRcVersion(params.version))
}
