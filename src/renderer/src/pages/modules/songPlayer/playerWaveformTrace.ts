export const resolvePlayerWaveformTraceElapsedMs = (startedAt: number) =>
  startedAt > 0 ? Number((performance.now() - startedAt).toFixed(1)) : undefined

export const sendPlayerWaveformTrace = (
  _scope: string,
  _stage: string,
  _payload?: Record<string, unknown>
) => {}
