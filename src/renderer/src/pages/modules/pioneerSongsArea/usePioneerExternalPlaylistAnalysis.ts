import { onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  IPioneerPlaylistTrack,
  IRekordboxSourceKind,
  ISongInfo
} from '../../../../../types/globals'

type PreparePlaylistAnalysisResult = {
  sourceKind?: string
  sourceId?: string
  usbUuid?: string
  completeFilePaths?: string[]
  queuedFilePaths?: string[]
  missingFilePaths?: string[]
}

type UsePioneerExternalPlaylistAnalysisParams = {
  sourceKind: ComputedRef<IRekordboxSourceKind | ''>
  sourceKey: ComputedRef<string>
  visibleSongs: Ref<ISongInfo[]>
  isCurrentPlaylistLoadTarget: (sourceCacheKey: string, playlistId: number) => boolean
}

const normalizePath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

export const usePioneerExternalPlaylistAnalysis = (
  params: UsePioneerExternalPlaylistAnalysisParams
) => {
  const frkbAnalyzedFilePaths = ref<string[]>([])

  const markFrkbAnalyzed = (filePaths: string[] | string) => {
    const list = Array.isArray(filePaths) ? filePaths : [filePaths]
    const next = new Set(frkbAnalyzedFilePaths.value)
    for (const filePath of list) {
      const normalized = String(filePath || '').trim()
      if (normalized) next.add(normalized)
    }
    frkbAnalyzedFilePaths.value = Array.from(next)
  }

  const unmarkFrkbAnalyzed = (filePaths: string[] | string) => {
    const list = Array.isArray(filePaths) ? filePaths : [filePaths]
    const removeSet = new Set(list.map((item) => normalizePath(String(item || ''))).filter(Boolean))
    if (!removeSet.size) return
    frkbAnalyzedFilePaths.value = frkbAnalyzedFilePaths.value.filter(
      (filePath) => !removeSet.has(normalizePath(filePath))
    )
  }

  const resetFrkbAnalyzedFilePaths = () => {
    frkbAnalyzedFilePaths.value = []
  }

  const prepareExternalPlaylistAnalysis = async (prepareParams: {
    sourceCacheKey: string
    playlistId: number
    rootPath: string
    tracks: IPioneerPlaylistTrack[]
  }) => {
    const { sourceCacheKey, playlistId, rootPath, tracks } = prepareParams
    const sourceKind = params.sourceKind.value
    if (sourceKind !== 'usb' && sourceKind !== 'desktop') return
    if (!rootPath) return
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel(sourceKind, 'prepare-playlist-analysis'),
        {
          sourceId: params.sourceKey.value,
          rootPath,
          tracks: tracks.map((track) => ({ filePath: track.filePath }))
        }
      )) as PreparePlaylistAnalysisResult | null
      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      const complete = Array.isArray(result?.completeFilePaths) ? result.completeFilePaths : []
      const missing = Array.isArray(result?.missingFilePaths) ? result.missingFilePaths : []
      resetFrkbAnalyzedFilePaths()
      if (complete.length) {
        markFrkbAnalyzed(complete)
      }
      if (missing.length) {
        unmarkFrkbAnalyzed(missing)
      }
    } catch (error) {
      console.error('[pioneerSongsArea] prepare playlist analysis failed', error)
    }
  }

  const handleAnalysisStageUpdate = (
    _event: unknown,
    payload?: {
      filePath?: string
      stage?: string
    }
  ) => {
    const filePath = String(payload?.filePath || '').trim()
    if (!filePath) return
    const visible = params.visibleSongs.value.some(
      (song) => normalizePath(song.filePath) === normalizePath(filePath)
    )
    if (!visible) return
    if (payload?.stage === 'job-done') {
      markFrkbAnalyzed(filePath)
      return
    }
    if (payload?.stage === 'job-error') {
      unmarkFrkbAnalyzed(filePath)
    }
  }

  if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.on('key-analysis:stage-update', handleAnalysisStageUpdate)
  }

  onUnmounted(() => {
    if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.removeListener(
        'key-analysis:stage-update',
        handleAnalysisStageUpdate
      )
    }
  })

  return {
    frkbAnalyzedFilePaths,
    resetFrkbAnalyzedFilePaths,
    prepareExternalPlaylistAnalysis
  }
}
