import { computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'

type TranslateFn = (key: string, params?: Record<string, unknown>) => string
type ConfirmDialogFn = typeof import('@renderer/components/confirmDialog').default

export type AnalysisRuntimePromptSource = 'startup' | 'help' | 'horizontal'
export type AnalysisRuntimePromptResult = 'ready' | 'started' | 'blocked'

type AnalysisRuntimeDownloadStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'extracting'
  | 'ready'
  | 'failed'

type AnalysisRuntimeDownloadState = {
  status: AnalysisRuntimeDownloadStatus
  profile: string
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

type AnalysisRuntimePreferredInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: string
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
}

const normalizeAnalysisRuntimeDownloadStatus = (value: unknown): AnalysisRuntimeDownloadStatus => {
  return value === 'available' ||
    value === 'downloading' ||
    value === 'extracting' ||
    value === 'ready' ||
    value === 'failed'
    ? value
    : 'idle'
}

const normalizeAnalysisRuntimeDownloadState = (value: unknown): AnalysisRuntimeDownloadState => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    status: normalizeAnalysisRuntimeDownloadStatus(raw.status),
    profile: typeof raw.profile === 'string' ? raw.profile.trim() : '',
    runtimeKey: typeof raw.runtimeKey === 'string' ? raw.runtimeKey.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : '',
    percent: Math.max(0, Math.min(100, Math.round(Number(raw.percent) || 0))),
    downloadedBytes: Math.max(0, Number(raw.downloadedBytes) || 0),
    totalBytes: Math.max(0, Number(raw.totalBytes) || 0),
    archiveSize: Math.max(0, Number(raw.archiveSize) || 0),
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    message: typeof raw.message === 'string' ? raw.message.trim() : '',
    error: typeof raw.error === 'string' ? raw.error.trim() : '',
    updatedAt: Math.max(0, Math.floor(Number(raw.updatedAt) || 0))
  }
}

const normalizeAnalysisRuntimePreferredInfo = (value: unknown): AnalysisRuntimePreferredInfo => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    supported: raw.supported === true,
    downloadable: raw.downloadable === true,
    alreadyAvailable: raw.alreadyAvailable === true,
    profile: typeof raw.profile === 'string' ? raw.profile.trim() : '',
    runtimeKey: typeof raw.runtimeKey === 'string' ? raw.runtimeKey.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : '',
    archiveSize: Math.max(0, Number(raw.archiveSize) || 0),
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    manifestUrl: typeof raw.manifestUrl === 'string' ? raw.manifestUrl.trim() : '',
    releaseTag: typeof raw.releaseTag === 'string' ? raw.releaseTag.trim() : '',
    error: typeof raw.error === 'string' ? raw.error.trim() : ''
  }
}

const formatAnalysisRuntimeBytes = (bytes: number) => {
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

export const useAnalysisRuntimeDownload = (options: {
  runtime: ReturnType<typeof useRuntimeStore>
  t: TranslateFn
  confirmDialog: ConfirmDialogFn
}) => {
  let analysisRuntimePromptBusy = false

  const applyAnalysisRuntimeStatus = (params: { preferred?: unknown; state?: unknown }) => {
    const preferred = normalizeAnalysisRuntimePreferredInfo(params.preferred)
    const state = normalizeAnalysisRuntimeDownloadState(params.state)
    options.runtime.analysisRuntime.preferred = preferred
    options.runtime.analysisRuntime.state = state
    options.runtime.analysisRuntime.available =
      preferred.alreadyAvailable || state.status === 'ready'
    if (
      !options.runtime.analysisRuntime.available &&
      options.runtime.mainWindowBrowseMode === 'horizontal'
    ) {
      options.runtime.mainWindowBrowseMode = 'browser'
    }
    return {
      preferred,
      state
    }
  }

  const refreshAnalysisRuntimeStatus = async () => {
    const response = await window.electron.ipcRenderer.invoke('analysis-runtime:get-status')
    return applyAnalysisRuntimeStatus({
      preferred: response?.preferred,
      state: response?.state
    })
  }

  const analysisRuntimeDownloadVisible = computed(() => {
    const status = options.runtime.analysisRuntime.state.status
    return status === 'downloading' || status === 'extracting'
  })

  const analysisRuntimeDownloadPercent = computed(() =>
    Math.max(0, Math.min(100, options.runtime.analysisRuntime.state.percent || 0))
  )

  const analysisRuntimeDownloadTitle = computed(() => {
    const { title } = options.runtime.analysisRuntime.state
    if (title) {
      return options.t('analysisRuntime.downloadTitle', {
        title
      })
    }
    return options.t('analysisRuntime.downloadTitleGeneric')
  })

  const analysisRuntimeDownloadText = computed(() => {
    const state = options.runtime.analysisRuntime.state
    if (state.status === 'downloading') {
      const totalBytes = state.totalBytes || state.archiveSize
      if (totalBytes > 0) {
        return options.t('analysisRuntime.downloadProgressText', {
          downloaded: formatAnalysisRuntimeBytes(state.downloadedBytes),
          total: formatAnalysisRuntimeBytes(totalBytes),
          percent: analysisRuntimeDownloadPercent.value
        })
      }
    }
    if (state.status === 'extracting') {
      return options.t('analysisRuntime.extractingText')
    }
    return (
      state.message ||
      options.t('analysisRuntime.downloadProgressText', {
        downloaded: formatAnalysisRuntimeBytes(state.downloadedBytes),
        total: formatAnalysisRuntimeBytes(state.totalBytes || state.archiveSize),
        percent: analysisRuntimeDownloadPercent.value
      })
    )
  })

  const resolvePromptResultFromCurrentState = (): AnalysisRuntimePromptResult => {
    if (options.runtime.analysisRuntime.available) return 'ready'
    const status = options.runtime.analysisRuntime.state.status
    if (status === 'downloading' || status === 'extracting') return 'started'
    return 'blocked'
  }

  const promptAnalysisRuntimeDownload = async (
    source: AnalysisRuntimePromptSource
  ): Promise<AnalysisRuntimePromptResult> => {
    if (analysisRuntimePromptBusy) return resolvePromptResultFromCurrentState()
    analysisRuntimePromptBusy = true
    try {
      const { preferred, state } = await refreshAnalysisRuntimeStatus()
      if (options.runtime.analysisRuntime.available) return 'ready'
      if (state.status === 'downloading' || state.status === 'extracting') return 'started'

      if (!preferred.supported) {
        if (source !== 'startup') {
          await options.confirmDialog({
            title: options.t('analysisRuntime.unsupportedTitle'),
            content: [options.t('analysisRuntime.unsupportedHint')],
            confirmShow: false,
            textAlign: 'left',
            innerWidth: 560,
            innerHeight: 0
          })
        }
        return 'blocked'
      }

      if (preferred.reason === 'manifest unavailable') {
        if (source !== 'startup') {
          const content = [
            options.t('analysisRuntime.manifestUnavailableHint'),
            options.t('mixtape.stemRuntimeNetworkHint')
          ]
          if (preferred.error) {
            content.push(options.t('analysisRuntime.downloadErrorHint', { error: preferred.error }))
          }
          await options.confirmDialog({
            title: options.t('analysisRuntime.unsupportedTitle'),
            content,
            confirmShow: false,
            textAlign: 'left',
            innerWidth: 560,
            innerHeight: 0
          })
        }
        return 'blocked'
      }

      if (!preferred.downloadable || !preferred.profile) return 'blocked'

      const confirmResult = await options.confirmDialog({
        title: options.t('analysisRuntime.promptTitle'),
        content: [
          options.t('analysisRuntime.promptBody', {
            title: preferred.title,
            size: formatAnalysisRuntimeBytes(preferred.archiveSize)
          }),
          options.t('analysisRuntime.promptHint')
        ],
        confirmShow: true,
        confirmText: options.t('analysisRuntime.downloadNow'),
        cancelText: options.t('analysisRuntime.downloadLater'),
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
      if (confirmResult !== 'confirm') return 'blocked'

      const response = await window.electron.ipcRenderer.invoke(
        'analysis-runtime:download-preferred'
      )
      const next = applyAnalysisRuntimeStatus({
        preferred,
        state: response?.state
      })
      if (options.runtime.analysisRuntime.available) return 'ready'
      if (next.state.status === 'downloading' || next.state.status === 'extracting')
        return 'started'
      return 'blocked'
    } catch (error) {
      if (source !== 'startup') {
        await options.confirmDialog({
          title: options.t('analysisRuntime.unsupportedTitle'),
          content: [
            options.t('analysisRuntime.downloadFailedHint'),
            options.t('analysisRuntime.downloadErrorHint', {
              error: error instanceof Error ? error.message : String(error || 'unknown')
            })
          ],
          confirmShow: false,
          textAlign: 'left',
          innerWidth: 560,
          innerHeight: 0
        })
      }
      return 'blocked'
    } finally {
      analysisRuntimePromptBusy = false
    }
  }

  const ensureAnalysisRuntimeForHorizontalMode = async () => {
    const result = await promptAnalysisRuntimeDownload('horizontal')
    if (result === 'ready' || options.runtime.analysisRuntime.available) return true
    if (result === 'started' || analysisRuntimeDownloadVisible.value) return false
    await options.confirmDialog({
      title: options.t('analysisRuntime.unsupportedTitle'),
      content: [options.t('analysisRuntime.horizontalBlockedHint')],
      confirmShow: false,
      textAlign: 'left',
      innerWidth: 560,
      innerHeight: 0
    })
    return false
  }

  const handleAnalysisRuntimeDownloadState = async (payload: unknown) => {
    const prevStatus = options.runtime.analysisRuntime.state.status
    const next = applyAnalysisRuntimeStatus({
      preferred: options.runtime.analysisRuntime.preferred,
      state: payload
    })
    if (next.state.status === 'ready' && prevStatus !== 'ready' && next.state.title) {
      await options.confirmDialog({
        title: options.t('common.success'),
        content: [options.t('analysisRuntime.readyHint', { title: next.state.title })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 520,
        innerHeight: 0
      })
      return
    }
    if (next.state.status === 'failed' && prevStatus !== 'failed') {
      const content = [options.t('analysisRuntime.downloadFailedHint')]
      if (next.state.error) {
        content.push(options.t('analysisRuntime.downloadErrorHint', { error: next.state.error }))
      }
      await options.confirmDialog({
        title: options.t('common.warning'),
        content,
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
    }
  }

  return {
    analysisRuntimeDownloadVisible,
    analysisRuntimeDownloadPercent,
    analysisRuntimeDownloadTitle,
    analysisRuntimeDownloadText,
    refreshAnalysisRuntimeStatus,
    promptAnalysisRuntimeDownload,
    ensureAnalysisRuntimeForHorizontalMode,
    handleAnalysisRuntimeDownloadState
  }
}
