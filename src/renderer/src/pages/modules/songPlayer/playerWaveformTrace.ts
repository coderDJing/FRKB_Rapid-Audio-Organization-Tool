export const resolvePlayerWaveformTraceElapsedMs = (startedAt: number) =>
  startedAt > 0 ? Number((performance.now() - startedAt).toFixed(1)) : undefined

export const sendPlayerWaveformTrace = (
  scope: string,
  stage: string,
  payload?: Record<string, unknown>
) => {
  try {
    const details = payload ? ` ${JSON.stringify(payload)}` : ''
    window.electron.ipcRenderer.send(
      'outputLog',
      `[trace/player-waveform][${scope}] ${stage}${details}`
    )
  } catch {}
}
