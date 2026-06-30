import { shell, type WebContents } from 'electron'

type WindowOpenHandlerResult = { action: 'deny' }

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export const isSafeExternalUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

export const openSafeExternalUrl = (url: string): void => {
  if (!isSafeExternalUrl(url)) return
  void shell.openExternal(url)
}

export const denyUnsafeWindowOpen = (details: { url: string }): WindowOpenHandlerResult => {
  openSafeExternalUrl(details.url)
  return { action: 'deny' }
}

const isSameLoadedFileUrl = (parsed: URL, currentUrl: string): boolean => {
  if (parsed.protocol !== 'file:') return false
  try {
    const current = new URL(currentUrl)
    return current.protocol === 'file:' && current.pathname === parsed.pathname
  } catch {
    return false
  }
}

const isInternalNavigationUrl = (url: string, currentUrl: string): boolean => {
  try {
    const parsed = new URL(url)
    if (isSameLoadedFileUrl(parsed, currentUrl)) return true
    const devRendererUrl = process.env.ELECTRON_RENDERER_URL || ''
    if (!devRendererUrl) return false
    const devOrigin = new URL(devRendererUrl).origin
    return parsed.origin === devOrigin
  } catch {
    return false
  }
}

export const restrictExternalNavigation = (webContents: WebContents): void => {
  webContents.setWindowOpenHandler(denyUnsafeWindowOpen)
  webContents.on('will-navigate', (event, url) => {
    if (isInternalNavigationUrl(url, webContents.getURL())) return
    event.preventDefault()
    openSafeExternalUrl(url)
  })
}
