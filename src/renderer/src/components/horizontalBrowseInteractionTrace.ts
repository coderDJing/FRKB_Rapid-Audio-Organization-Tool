export const sendHorizontalBrowseInteractionTrace = (
  stage: string,
  payload?: Record<string, unknown>
) => {
  try {
    const details = payload ? ` ${JSON.stringify(payload)}` : ''
    window.electron.ipcRenderer.send(
      'outputLog',
      `[trace/horizontal-interaction] ${stage}${details}`
    )
  } catch {}
}
