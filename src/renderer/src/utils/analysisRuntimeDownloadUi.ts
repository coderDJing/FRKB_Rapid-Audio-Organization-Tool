type TranslateFn = (key: string, params?: Record<string, unknown>) => string

type AnalysisRuntimeDisplayState = {
  status?: unknown
  title?: unknown
  message?: unknown
  percent?: unknown
  downloadedBytes?: unknown
  totalBytes?: unknown
  archiveSize?: unknown
}

const clampAnalysisRuntimePercent = (value: unknown) =>
  Math.max(0, Math.min(100, Math.round(Number(value) || 0)))

export const isAnalysisRuntimeDownloadActiveStatus = (value: unknown) =>
  value === 'downloading' || value === 'extracting'

export const formatAnalysisRuntimeBytes = (bytes: unknown) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, Number(bytes) || 0)
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 ? 0 : unitIndex === 1 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export const resolveAnalysisRuntimeDownloadPercent = (state: AnalysisRuntimeDisplayState) =>
  clampAnalysisRuntimePercent(state.percent)

export const resolveAnalysisRuntimeDownloadTitle = (
  t: TranslateFn,
  state: AnalysisRuntimeDisplayState
) => {
  const title = typeof state.title === 'string' ? state.title.trim() : ''
  if (title) {
    return t('analysisRuntime.downloadTitle', { title })
  }
  return t('analysisRuntime.downloadTitleGeneric')
}

export const resolveAnalysisRuntimeDownloadText = (
  t: TranslateFn,
  state: AnalysisRuntimeDisplayState
) => {
  const percent = resolveAnalysisRuntimeDownloadPercent(state)
  const totalBytes = Math.max(0, Number(state.totalBytes) || 0)
  const archiveSize = Math.max(0, Number(state.archiveSize) || 0)
  const downloadedBytes = Math.max(0, Number(state.downloadedBytes) || 0)
  const message = typeof state.message === 'string' ? state.message.trim() : ''

  if (state.status === 'downloading') {
    const total = totalBytes || archiveSize
    if (total > 0) {
      return t('analysisRuntime.downloadProgressText', {
        downloaded: formatAnalysisRuntimeBytes(downloadedBytes),
        total: formatAnalysisRuntimeBytes(total),
        percent
      })
    }
  }

  if (state.status === 'extracting') {
    return t('analysisRuntime.extractingText')
  }

  return (
    message ||
    t('analysisRuntime.downloadProgressText', {
      downloaded: formatAnalysisRuntimeBytes(downloadedBytes),
      total: formatAnalysisRuntimeBytes(totalBytes || archiveSize),
      percent
    })
  )
}
