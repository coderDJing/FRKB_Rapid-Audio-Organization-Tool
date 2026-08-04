import { app, type BrowserWindow, type ProcessMetric } from 'electron'
import { log } from '../../log'

const MAIN_PROCESS_STALL_THRESHOLD_MS = 3_000
const MAIN_PROCESS_HEARTBEAT_INTERVAL_MS = 1_000

type ResponsivenessSnapshot = {
  windowId: number
  webContentsId: number
  rendererPid: number | null
  url: string | null
  loading: boolean
  focused: boolean
  visible: boolean
  processMetrics: ProcessMetric[]
}

const getRendererPid = (browserWindow: BrowserWindow): number | null => {
  try {
    return browserWindow.webContents.getOSProcessId()
  } catch {
    return null
  }
}

const getProcessMetrics = (rendererPid: number | null): ProcessMetric[] => {
  try {
    return app
      .getAppMetrics()
      .filter(
        (metric) =>
          metric.pid === rendererPid ||
          metric.type === 'Browser' ||
          metric.type === 'GPU' ||
          metric.type === 'Utility'
      )
  } catch {
    return []
  }
}

const captureSnapshot = (browserWindow: BrowserWindow): ResponsivenessSnapshot => {
  const rendererPid = getRendererPid(browserWindow)
  let url: string | null = null
  try {
    url = browserWindow.webContents.getURL() || null
  } catch {}

  return {
    windowId: browserWindow.id,
    webContentsId: browserWindow.webContents.id,
    rendererPid,
    url,
    loading: browserWindow.webContents.isLoading(),
    focused: browserWindow.isFocused(),
    visible: browserWindow.isVisible(),
    processMetrics: getProcessMetrics(rendererPid)
  }
}

/**
 * 记录 Windows 未响应的可定位证据：
 * - Electron 事件用于区分 renderer 卡死、恢复和崩溃；
 * - 心跳延迟用于发现主进程消息循环被同步任务或原生调用阻塞的情况。
 */
export const attachMainWindowResponsivenessDiagnostics = (browserWindow: BrowserWindow) => {
  let rendererUnresponsiveAt: number | null = null
  let lastHeartbeatAt = Date.now()

  const heartbeat = setInterval(() => {
    const now = Date.now()
    const stallDurationMs = now - lastHeartbeatAt - MAIN_PROCESS_HEARTBEAT_INTERVAL_MS
    lastHeartbeatAt = now
    if (stallDurationMs < MAIN_PROCESS_STALL_THRESHOLD_MS || browserWindow.isDestroyed()) {
      return
    }
    log.error('[main-window] main-process event loop stalled', {
      stallDurationMs,
      snapshot: captureSnapshot(browserWindow)
    })
  }, MAIN_PROCESS_HEARTBEAT_INTERVAL_MS)

  browserWindow.webContents.on('unresponsive', () => {
    if (rendererUnresponsiveAt !== null) {
      return
    }
    rendererUnresponsiveAt = Date.now()
    log.error('[main-window] renderer unresponsive', {
      snapshot: captureSnapshot(browserWindow)
    })
  })

  browserWindow.webContents.on('responsive', () => {
    if (rendererUnresponsiveAt === null) {
      return
    }
    const durationMs = Date.now() - rendererUnresponsiveAt
    rendererUnresponsiveAt = null
    log.error('[main-window] renderer recovered', {
      durationMs,
      snapshot: captureSnapshot(browserWindow)
    })
  })

  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    const durationMs =
      rendererUnresponsiveAt === null ? null : Math.max(0, Date.now() - rendererUnresponsiveAt)
    rendererUnresponsiveAt = null
    log.error('[main-window] render-process-gone', {
      details,
      unresponsiveDurationMs: durationMs,
      snapshot: captureSnapshot(browserWindow)
    })
  })

  const dispose = () => clearInterval(heartbeat)
  browserWindow.once('closed', dispose)
  return dispose
}
