export type WaveformPlaceholderState = 'loading' | 'unavailable' | 'ready'

type WaveformPreviewRetryOptions = {
  resolvePlaceholderState: (filePath: string) => WaveformPlaceholderState | undefined
  retryLoading: (filePath: string) => void
}

const WAVEFORM_LOADING_RETRY_MS = 8000
const WAVEFORM_MISSING_RETRY_MS = 600

export const createWaveformPreviewRetry = (options: WaveformPreviewRetryOptions) => {
  const loadingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const missingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const clearLoadingRetryTimer = (filePath: string) => {
    const timer = loadingRetryTimers.get(filePath)
    if (!timer) return
    clearTimeout(timer)
    loadingRetryTimers.delete(filePath)
  }

  const clearMissingRetryTimer = (filePath: string) => {
    const timer = missingRetryTimers.get(filePath)
    if (!timer) return
    clearTimeout(timer)
    missingRetryTimers.delete(filePath)
  }

  const scheduleRetry = (
    filePath: string,
    delayMs: number,
    timers: Map<string, ReturnType<typeof setTimeout>>
  ) => {
    if (!filePath || timers.has(filePath)) return
    const timer = setTimeout(() => {
      timers.delete(filePath)
      if (options.resolvePlaceholderState(filePath) === 'loading') {
        options.retryLoading(filePath)
      }
    }, delayMs)
    timers.set(filePath, timer)
  }

  const trackLoading = (filePath: string) => {
    if (!filePath) return
    clearLoadingRetryTimer(filePath)
    scheduleRetry(filePath, WAVEFORM_LOADING_RETRY_MS, loadingRetryTimers)
  }

  const retryMissingSoon = (filePath: string) => {
    scheduleRetry(filePath, WAVEFORM_MISSING_RETRY_MS, missingRetryTimers)
  }

  const clear = (filePath: string) => {
    clearLoadingRetryTimer(filePath)
    clearMissingRetryTimer(filePath)
  }

  const clearAll = () => {
    for (const timer of loadingRetryTimers.values()) clearTimeout(timer)
    for (const timer of missingRetryTimers.values()) clearTimeout(timer)
    loadingRetryTimers.clear()
    missingRetryTimers.clear()
  }

  return {
    clear,
    clearAll,
    retryMissingSoon,
    trackLoading
  }
}
