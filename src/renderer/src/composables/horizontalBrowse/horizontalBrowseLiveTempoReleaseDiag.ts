// [HB-TEMPO-RELEASE-DIAG] 阶段 2 临时诊断：定位“播放态松手横向位置跳”。
// 见 drafts/intermittent-bugs/horizontal-browse-live-tempo-release-jitter.md 阶段 2。
//
// 采样通过现有 outputLog IPC 落盘到项目根目录 log.txt（dev）/ userData/log.txt（打包），
// 统一带 [HB-TEMPO-RELEASE-DIAG] 标签，复现后直接检索 log.txt 即可，无需 devtools。
// 真机复现拿到数据、定位根因并修复后，按项目 Debug Logging 规则整文件删除，并移除调用点。

const DIAG_TAG = '[HB-TEMPO-RELEASE-DIAG]'
const DIAG_SCOPE = 'hb-tempo-release'

type DiagValue = number | string | boolean | null

type IpcSenderWindow = typeof globalThis & {
  electron?: {
    ipcRenderer?: {
      send?: (channel: string, payload: unknown) => void
    }
  }
}

const formatData = (data: Record<string, DiagValue>) => {
  const parts: string[] = []
  for (const [key, value] of Object.entries(data)) {
    const text =
      typeof value === 'number' && Number.isFinite(value)
        ? Number(value.toFixed(4)).toString()
        : String(value)
    parts.push(`${key}=${text}`)
  }
  return parts.join(' ')
}

export const recordHorizontalBrowseLiveTempoReleaseDiag = (
  deckDirection: string,
  phase: string,
  data: Record<string, DiagValue>
) => {
  if (typeof window === 'undefined') return
  const send = (window as IpcSenderWindow).electron?.ipcRenderer?.send
  if (typeof send !== 'function') return
  const message = `${DIAG_TAG} dir=${deckDirection} phase=${phase} ${formatData(data)}`
  try {
    send('outputLog', {
      level: 'info',
      scope: DIAG_SCOPE,
      source: 'renderer',
      message
    })
  } catch {}
}
