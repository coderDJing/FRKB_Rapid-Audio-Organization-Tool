export const resolveHorizontalBrowseWaveformTraceElapsedMs = (startedAt: number) =>
  startedAt > 0 ? Number((performance.now() - startedAt).toFixed(1)) : undefined

export const sendHorizontalBrowseWaveformTrace = (
  _scope: string,
  _stage: string,
  _payload?: Record<string, unknown>
) => {}
