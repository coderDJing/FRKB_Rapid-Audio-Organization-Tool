type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

declare global {
  interface Window {
    __FRKB_CONSOLE_LOG_BRIDGE__?: boolean
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

export const installConsoleLogBridge = (scope: string) => {
  if (typeof window === 'undefined') return
  if (window.__FRKB_CONSOLE_LOG_BRIDGE__) return
  if (!window?.electron?.ipcRenderer?.send) return
  window.__FRKB_CONSOLE_LOG_BRIDGE__ = true

  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']
  for (const method of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      if (method !== 'error') return
      try {
        const message = args.map((item) => stringifyArg(item)).join(' ')
        window.electron.ipcRenderer.send('outputLog', {
          level: 'error',
          scope,
          source: 'renderer-console',
          message: `[console.${method}] ${message}`
        })
      } catch {}
    }
  }
}
