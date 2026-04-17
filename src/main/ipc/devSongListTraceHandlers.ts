import { app, contentTracing, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'fs-extra'
import mainWindow from '../window/mainWindow'
import { log } from '../log'

type DevSongListTraceMode = 'idle' | 'recording'

type TraceRecordingMeta = {
  startedAt: number
}

type TraceStatePayload = {
  phase:
    | 'idle'
    | 'start-requested'
    | 'recording'
    | 'stop-requested'
    | 'export-started'
    | 'export-verifying'
    | 'exported'
    | 'error'
  message: string
  filePath?: string
  durationMs?: number
}

const TRACE_EXPORT_DIR_NAME = 'FRKB-dev-traces'
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'toplevel',
  'cc',
  'gpu',
  'input',
  'latencyInfo',
  'renderer.scheduler',
  'v8.execute'
]

const isDevMode = () => process.env.NODE_ENV === 'development'

const buildTraceTimestamp = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const resolveTraceExportDir = () => path.join(app.getPath('desktop'), TRACE_EXPORT_DIR_NAME)

const buildTraceFilePath = () =>
  path.join(resolveTraceExportDir(), `songlist-trace-${buildTraceTimestamp()}.json`)

const sendToRenderer = (channel: string, payload: Record<string, unknown>) => {
  if (!mainWindow.instance || mainWindow.instance.isDestroyed()) return
  try {
    mainWindow.instance.webContents.send(channel, payload)
  } catch {}
}

const emitTraceState = (payload: TraceStatePayload) => {
  const logPayload = {
    phase: payload.phase,
    message: payload.message,
    filePath: payload.filePath,
    durationMs: payload.durationMs
  }
  if (payload.phase === 'error') {
    log.error('[dev-songlist-trace] state', logPayload)
  }
  sendToRenderer('dev-songlist-trace:state', payload)
}

export function registerDevSongListTraceHandlers() {
  let mode: DevSongListTraceMode = 'idle'
  let recordingMeta: TraceRecordingMeta | null = null
  let operationQueue = Promise.resolve<unknown>(undefined)

  const getSnapshot = () => ({
    enabled: isDevMode(),
    mode,
    recordingMeta: recordingMeta
      ? {
          startedAt: recordingMeta.startedAt
        }
      : null
  })

  const runExclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    const next = operationQueue.then(task, task)
    operationQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  const startRecordingInternal = async () => {
    if (!isDevMode()) {
      return {
        ok: false,
        mode,
        message: '仅 dev 模式可用'
      }
    }

    if (mode === 'recording') {
      return {
        ok: true,
        mode,
        message: '当前已经在录制中。'
      }
    }

    emitTraceState({
      phase: 'start-requested',
      message: '准备开始录制 trace。'
    })
    try {
      await contentTracing.startRecording({
        included_categories: TRACE_CATEGORIES
      })
      mode = 'recording'
      recordingMeta = {
        startedAt: Date.now()
      }
      emitTraceState({
        phase: 'recording',
        message: '已开始录制 trace。手动点击“结束录制并导出”后再等待导出完成。'
      })
      return {
        ok: true,
        mode,
        message: '已开始录制 trace。'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'start failed')
      mode = 'idle'
      recordingMeta = null
      emitTraceState({
        phase: 'error',
        message: `开始录制失败：${message}`
      })
      sendToRenderer('dev-songlist-trace:error', {
        stage: 'start',
        message
      })
      return {
        ok: false,
        mode,
        message
      }
    }
  }

  const stopRecordingInternal = async () => {
    if (!isDevMode()) {
      return {
        ok: false,
        mode,
        message: '仅 dev 模式可用'
      }
    }

    if (mode !== 'recording' || !recordingMeta) {
      mode = 'idle'
      recordingMeta = null
      emitTraceState({
        phase: 'idle',
        message: '当前没有正在进行的 trace 录制。'
      })
      return {
        ok: true,
        mode,
        message: '当前没有正在进行的 trace 录制。'
      }
    }

    const activeMeta = recordingMeta
    mode = 'idle'
    recordingMeta = null
    const exportPath = buildTraceFilePath()
    emitTraceState({
      phase: 'stop-requested',
      message: '收到结束录制请求，准备导出 trace。此时先别关窗口。'
    })
    emitTraceState({
      phase: 'export-started',
      message: `正在导出 trace 到：${exportPath}。导出完成前别关窗口。`,
      filePath: exportPath
    })

    try {
      await fs.ensureDir(path.dirname(exportPath))
      const finalPath = await contentTracing.stopRecording(exportPath)
      emitTraceState({
        phase: 'export-verifying',
        message: 'trace 已写出，正在校验文件是否真实存在。',
        filePath: finalPath
      })
      const fileExists = await fs.pathExists(finalPath)
      if (!fileExists) {
        const message = `trace 导出结束，但文件不存在：${finalPath}`
        emitTraceState({
          phase: 'error',
          message,
          filePath: finalPath
        })
        sendToRenderer('dev-songlist-trace:error', {
          stage: 'export',
          message,
          filePath: finalPath
        })
        return {
          ok: false,
          mode,
          message,
          filePath: finalPath
        }
      }

      const durationMs = Math.max(0, Date.now() - activeMeta.startedAt)
      emitTraceState({
        phase: 'exported',
        message: `trace 导出完成：${finalPath}。现在可以关窗口了。`,
        filePath: finalPath,
        durationMs
      })
      sendToRenderer('dev-songlist-trace:exported', {
        filePath: finalPath,
        durationMs
      })

      try {
        await shell.showItemInFolder(finalPath)
      } catch {}

      return {
        ok: true,
        mode,
        message: `trace 导出完成：${finalPath}`,
        filePath: finalPath,
        durationMs
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'stop failed')
      emitTraceState({
        phase: 'error',
        message: `结束录制或导出失败：${message}`,
        filePath: exportPath
      })
      sendToRenderer('dev-songlist-trace:error', {
        stage: 'stop',
        message,
        filePath: exportPath
      })
      return {
        ok: false,
        mode,
        message,
        filePath: exportPath
      }
    }
  }

  ipcMain.handle('dev-songlist-trace:start', () => runExclusive(startRecordingInternal))
  ipcMain.handle('dev-songlist-trace:stop', () => runExclusive(stopRecordingInternal))
  ipcMain.handle('dev-songlist-trace:status', () => getSnapshot())
}
