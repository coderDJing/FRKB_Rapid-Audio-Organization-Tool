import confirm from '@renderer/components/confirmDialog'

const showDevSongListTraceDialog = async (content: string[]) => {
  await confirm({
    title: 'Trace 录制',
    content,
    confirmShow: false,
    canCopyText: true,
    innerHeight: 260
  })
}

const logDevSongListTraceInfo = (message: string, payload?: Record<string, unknown>) => {
  void message
  void payload
}

const logDevSongListTraceWarn = (message: string, payload?: Record<string, unknown>) => {
  void message
  void payload
}

const logDevSongListTraceError = (message: string, payload?: Record<string, unknown>) => {
  if (payload && Object.keys(payload).length > 0) {
    console.error('[dev-songlist-trace]', message, payload)
    return
  }
  console.error('[dev-songlist-trace]', message)
}

const startDevSongListTrace = async () => {
  try {
    logDevSongListTraceInfo('手动开始 trace 录制')
    const result = await window.electron.ipcRenderer.invoke('dev-songlist-trace:start')
    const message = String(result?.message || '').trim()
    logDevSongListTraceInfo(message || 'trace 录制状态已更新', {
      mode: result?.mode
    })
    if (!message) return
    await showDevSongListTraceDialog([message])
  } catch (error) {
    logDevSongListTraceError('手动开始 trace 录制失败', {
      error: error instanceof Error ? error.message : String(error)
    })
    await showDevSongListTraceDialog([
      `开始 Trace 录制失败：${error instanceof Error ? error.message : String(error)}`
    ])
  }
}

const stopDevSongListTrace = async () => {
  try {
    logDevSongListTraceInfo('手动结束 trace 录制并导出')
    const result = await window.electron.ipcRenderer.invoke('dev-songlist-trace:stop')
    const message = String(result?.message || '').trim()
    logDevSongListTraceInfo(message || 'trace 导出流程已触发', {
      mode: result?.mode,
      filePath: result?.filePath || ''
    })
    if (!message) return
    if (result?.ok !== true || !result?.filePath) {
      await showDevSongListTraceDialog([message])
    }
  } catch (error) {
    logDevSongListTraceError('手动结束 trace 录制失败', {
      error: error instanceof Error ? error.message : String(error)
    })
    await showDevSongListTraceDialog([
      `结束 Trace 录制失败：${error instanceof Error ? error.message : String(error)}`
    ])
  }
}

const handleDevSongListTraceState = (
  _event: unknown,
  payload?: {
    phase?: string
    message?: string
    playlistUuid?: string
    playlistName?: string
    playlistType?: string
    filePath?: string
    durationMs?: number
  }
) => {
  const phase = String(payload?.phase || '').trim()
  const message = String(payload?.message || '').trim()
  const meta = {
    phase,
    playlistUuid: String(payload?.playlistUuid || '').trim(),
    playlistName: String(payload?.playlistName || '').trim(),
    playlistType: String(payload?.playlistType || '').trim(),
    filePath: String(payload?.filePath || '').trim(),
    durationMs: Math.max(0, Number(payload?.durationMs) || 0)
  }
  const logMessage = message || `歌单 trace 状态变化：${phase || 'unknown'}`
  if (phase === 'error') {
    logDevSongListTraceError(logMessage, meta)
    return
  }
  if (phase === 'click-ignored-idle') {
    logDevSongListTraceWarn(logMessage, meta)
    return
  }
  if (phase === 'export-started' || phase === 'stop-requested' || phase === 'export-verifying') {
    logDevSongListTraceWarn(logMessage, meta)
    return
  }
  logDevSongListTraceInfo(logMessage, meta)
}

const handleDevSongListTraceExported = async (
  _event: unknown,
  payload?: {
    filePath?: string
    durationMs?: number
    startedPlaylistName?: string
    endedPlaylistName?: string
  }
) => {
  const filePath = String(payload?.filePath || '').trim()
  const durationMs = Math.max(0, Number(payload?.durationMs) || 0)
  const startedPlaylistName = String(payload?.startedPlaylistName || '').trim()
  const endedPlaylistName = String(payload?.endedPlaylistName || '').trim()
  const lines = [
    'Trace 已导出。',
    filePath ? `文件：${filePath}` : '',
    durationMs > 0 ? `录制时长：${durationMs} ms` : '',
    startedPlaylistName ? `开始歌单：${startedPlaylistName}` : '',
    endedPlaylistName ? `结束歌单：${endedPlaylistName}` : ''
  ].filter(Boolean)
  logDevSongListTraceInfo('歌单 trace 已导出，现在可以关闭窗口了', {
    filePath,
    durationMs,
    startedPlaylistName,
    endedPlaylistName
  })
  await showDevSongListTraceDialog(lines)
}

const handleDevSongListTraceError = async (
  _event: unknown,
  payload?: { stage?: string; message?: string }
) => {
  const stage = String(payload?.stage || '').trim()
  const message = String(payload?.message || '').trim()
  logDevSongListTraceError('trace 录制失败', {
    stage,
    message
  })
  await showDevSongListTraceDialog(
    ['Trace 录制失败。', stage ? `阶段：${stage}` : '', message || '未知错误'].filter(Boolean)
  )
}

/**
 * 开发用「歌单 trace 录制」相关逻辑（手动开始/结束、状态与导出/错误事件处理）。
 * 从 App.vue 抽出，保持其原有职责边界。
 */
export function useDevSongListTrace() {
  return {
    startDevSongListTrace,
    stopDevSongListTrace,
    handleDevSongListTraceState,
    handleDevSongListTraceExported,
    handleDevSongListTraceError
  }
}
