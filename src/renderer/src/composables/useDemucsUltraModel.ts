import { computed, ref, type Ref } from 'vue'

export type StemProfile = 'quality' | 'ultra'

type ModelDownloadStatus = 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'

type DemucsUltraModelDownloadState = {
  status: ModelDownloadStatus
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  message: string
  error: string
}

type DemucsUltraModelInfo = {
  version: string
  archiveSize: number
  installedSize: number
  downloadable: boolean
  alreadyAvailable: boolean
  reason: string
  error: string
  state: DemucsUltraModelDownloadState
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const parseUltraModelState = (value: unknown): DemucsUltraModelDownloadState | null => {
  if (!isRecord(value)) return null
  const status = value.status
  if (
    status !== 'idle' &&
    status !== 'available' &&
    status !== 'downloading' &&
    status !== 'extracting' &&
    status !== 'ready' &&
    status !== 'failed'
  ) {
    return null
  }
  return {
    status,
    version: typeof value.version === 'string' ? value.version.trim() : '',
    percent: Math.max(0, Math.min(100, Number(value.percent) || 0)),
    downloadedBytes: Math.max(0, Number(value.downloadedBytes) || 0),
    totalBytes: Math.max(0, Number(value.totalBytes) || 0),
    archiveSize: Math.max(0, Number(value.archiveSize) || 0),
    message: typeof value.message === 'string' ? value.message.trim() : '',
    error: typeof value.error === 'string' ? value.error.trim() : ''
  }
}

const parseUltraModelInfo = (value: unknown): DemucsUltraModelInfo | null => {
  if (!isRecord(value)) return null
  const state = parseUltraModelState(value.state)
  if (!state) return null
  return {
    version: typeof value.version === 'string' ? value.version.trim() : '',
    archiveSize: Math.max(0, Number(value.archiveSize) || 0),
    installedSize: Math.max(0, Number(value.installedSize) || 0),
    downloadable: value.downloadable === true,
    alreadyAvailable: value.alreadyAvailable === true,
    reason: typeof value.reason === 'string' ? value.reason.trim() : '',
    error: typeof value.error === 'string' ? value.error.trim() : '',
    state
  }
}

export const useDemucsUltraModel = (selectedProfile: Ref<StemProfile>) => {
  const ultraModelInfo = ref<DemucsUltraModelInfo | null>(null)
  const ultraModelReady = computed(
    () =>
      selectedProfile.value !== 'ultra' ||
      ultraModelInfo.value?.alreadyAvailable === true ||
      ultraModelInfo.value?.state.status === 'ready'
  )
  const modelDownloadBusy = computed(() => {
    const status = ultraModelInfo.value?.state.status
    return status === 'downloading' || status === 'extracting'
  })
  const refreshUltraModelInfo = async () => {
    try {
      const next = await window.electron.ipcRenderer.invoke('demucs-model:get-ultra-status')
      const parsed = parseUltraModelInfo(next)
      if (parsed) ultraModelInfo.value = parsed
    } catch {
      ultraModelInfo.value = null
    }
  }

  const handleUltraModelDownloadState = (_event: unknown, payload: unknown) => {
    const state = parseUltraModelState(payload)
    if (!state) return
    ultraModelInfo.value = {
      version: state.version || ultraModelInfo.value?.version || '',
      archiveSize: state.archiveSize || ultraModelInfo.value?.archiveSize || 0,
      installedSize:
        state.status === 'ready' ? state.archiveSize : ultraModelInfo.value?.installedSize || 0,
      downloadable: state.status !== 'ready',
      alreadyAvailable: state.status === 'ready',
      reason: state.status === 'ready' ? 'already available' : '',
      error: state.error,
      state
    }
    if (state.status === 'ready') void refreshUltraModelInfo()
  }

  return {
    ultraModelInfo,
    ultraModelReady,
    modelDownloadBusy,
    refreshUltraModelInfo,
    handleUltraModelDownloadState
  }
}
