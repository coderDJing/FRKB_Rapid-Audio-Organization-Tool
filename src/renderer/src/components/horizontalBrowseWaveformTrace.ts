export const resolveHorizontalBrowseWaveformTraceElapsedMs = (startedAt: number) =>
  startedAt > 0 ? Number((performance.now() - startedAt).toFixed(1)) : undefined

export const sendHorizontalBrowseWaveformTrace = (
  scope: string,
  stage: string,
  payload?: Record<string, unknown>
) => {
  try {
    const details = payload ? ` ${JSON.stringify(payload)}` : ''
    window.electron.ipcRenderer.send(
      'outputLog',
      `[trace/horizontal-waveform][${scope}] ${stage}${details}`
    )
  } catch {}
}
