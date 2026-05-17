export const resolveHorizontalBrowseWaveformTraceElapsedMs = (startedAt: number) =>
  startedAt > 0 ? Number((performance.now() - startedAt).toFixed(1)) : undefined

const stringifyTracePayload = (payload?: Record<string, unknown>) => {
  if (!payload) return ''
  try {
    return JSON.stringify(payload)
  } catch {
    return '[unserializable]'
  }
}

export const sendHorizontalBrowseWaveformTrace = (
  scope: string,
  stage: string,
  payload?: Record<string, unknown>
) => {
  if (!window?.electron?.ipcRenderer?.send) return
  const safeScope = String(scope || 'waveform').trim() || 'waveform'
  const safeStage = String(stage || 'unknown').trim() || 'unknown'
  const serializedPayload = stringifyTracePayload(payload)
  window.electron.ipcRenderer.send('outputLog', {
    level: 'info',
    source: 'renderer',
    scope: 'horizontal-waveform',
    message: `[hb-waveform:${safeScope}] ${safeStage}${
      serializedPayload ? ` ${serializedPayload}` : ''
    }`
  })
}
