import type { BrowserWindow } from 'electron'

export type SendProgress = (
  payloadOrTitle: any,
  current?: number,
  total?: number,
  isInitial?: boolean,
  id?: string
) => void

export function createProgressSender(getWindow: () => BrowserWindow | null): SendProgress {
  return (
    payloadOrTitle: any,
    current?: number,
    total?: number,
    isInitial = false,
    id?: string
  ) => {
    const targetWindow = getWindow()
    if (!targetWindow) return

    if (payloadOrTitle && typeof payloadOrTitle === 'object') {
      targetWindow.webContents.send('progressSet', payloadOrTitle)
      return
    }
    if (id) {
      targetWindow.webContents.send('progressSet', {
        id,
        titleKey: String(payloadOrTitle || ''),
        now: Number(current) || 0,
        total: Number(total) || 0,
        isInitial: !!isInitial
      })
      return
    }
    targetWindow.webContents.send('progressSet', payloadOrTitle, current, total, isInitial)
  }
}
