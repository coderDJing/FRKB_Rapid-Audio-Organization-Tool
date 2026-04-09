type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

declare global {
  interface Window {
    __FRKB_CONSOLE_BRIDGED__?: boolean
  }
}

const stringifyArg = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message || String(value)
  try {
    return JSON.stringify(value)
  } catch {
    try {
      return String(value)
    } catch {
      return '[unserializable]'
    }
  }
}

export const installConsoleLogBridge = (scope = 'renderer') => {
  if (typeof window === 'undefined' || window.__FRKB_CONSOLE_BRIDGED__) return
  if (!window?.electron?.ipcRenderer?.send) return
  window.__FRKB_CONSOLE_BRIDGED__ = true

  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']
  for (const method of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      try {
        const message = args.map((item) => stringifyArg(item)).join(' ')
        window.electron.ipcRenderer.send('outputLog', `[${scope}][console.${method}] ${message}`)
      } catch {}
    }
  }
}
