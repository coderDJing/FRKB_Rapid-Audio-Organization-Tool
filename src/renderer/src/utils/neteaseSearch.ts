export const normalizeNeteaseSearchText = (value: string | undefined | null) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''

export const buildNeteaseSearchQuery = (...values: Array<string | undefined | null>) =>
  values.map(normalizeNeteaseSearchText).filter(Boolean).join(' ')

export const buildNeteaseSearchUrl = (query: string) =>
  `https://music.163.com/#/search/m/?s=${encodeURIComponent(query)}&type=1`

export const openNeteaseSearch = (query: string) => {
  const normalized = normalizeNeteaseSearchText(query)
  if (!normalized) return false
  window.electron.ipcRenderer.send('openLocalBrowser', buildNeteaseSearchUrl(normalized))
  return true
}
