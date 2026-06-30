import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { loadUnifiedDisplayWaveformData } from '@renderer/composables/horizontalBrowse/horizontalBrowseCompactVisualWaveform'
import { isSameHorizontalBrowseSongFilePath } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import { createRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformPlaceholder'
import { createHorizontalBrowseCompactVisualWaveformWorker } from '@renderer/workers/horizontalBrowseCompactVisualWaveform.workerClient'
import type {
  HorizontalBrowseCompactVisualWaveformWorkerIncoming,
  HorizontalBrowseCompactVisualWaveformWorkerOutgoing
} from '@renderer/workers/horizontalBrowseCompactVisualWaveform.types'

type UseHorizontalBrowseCompactVisualWaveformStripOptions = {
  song: () => ISongInfo | null
  active: Ref<boolean>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  previewLoading: Ref<boolean>
  previewZoom: Ref<number>
  resolveVisibleDurationSec: () => number
  resolvePreviewAnchorSec: () => number
  clampPreviewStart: (value: number) => number
  replaceLiveWaveformRaw: (data: RawWaveformData | null) => void
  resetPlaybackRenderState: () => void
  scheduleDraw: () => void
}

const isRawDataCoveringRange = (data: RawWaveformData | null, startSec: number, endSec: number) => {
  if (!data || !Number.isFinite(startSec) || !Number.isFinite(endSec)) return false
  const rate = Math.max(1, Number(data.rate) || 1)
  const start = Math.max(0, Number(data.startSec) || 0)
  const loadedFrames = Math.max(0, Number(data.loadedFrames ?? data.frames) || 0)
  const end = start + loadedFrames / rate
  const duration = Math.max(0, Number(data.duration) || 0)
  const audibleStart = Math.max(0, startSec)
  const audibleEnd = duration > 0 ? Math.min(endSec, duration) : endSec
  if (audibleEnd <= audibleStart) return true
  return audibleStart >= start - 0.001 && audibleEnd <= end + 0.001
}

export const useHorizontalBrowseCompactVisualWaveformStrip = (
  options: UseHorizontalBrowseCompactVisualWaveformStripOptions
) => {
  const worker = createHorizontalBrowseCompactVisualWaveformWorker()
  let token = 0
  let requestKey = ''

  const clearWaveformShape = () => {
    options.rawData.value = null
    options.mixxxData.value = null
    options.replaceLiveWaveformRaw(null)
  }

  const resolveRequestRange = (anchorSec?: number) => {
    const visibleDuration = options.resolveVisibleDurationSec()
    const anchor = Number.isFinite(Number(anchorSec))
      ? Number(anchorSec)
      : options.resolvePreviewAnchorSec()
    const visibleStart = options.clampPreviewStart(
      anchor - visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    const visibleEnd = visibleStart + visibleDuration
    return {
      visibleStart,
      visibleEnd
    }
  }

  const postBuild = (
    buildToken: number,
    data: HorizontalBrowseCompactVisualWaveformWorkerIncoming['payload']['data']
  ) => {
    worker.postMessage({
      type: 'buildStrip',
      payload: { token: buildToken, data }
    } satisfies HorizontalBrowseCompactVisualWaveformWorkerIncoming)
  }

  const request = async (
    anchorSec?: number,
    requestOptions: { force?: boolean; clearIfOutside?: boolean } = {}
  ) => {
    const filePath = String(options.song()?.filePath || '').trim()
    if (!filePath || (!options.active.value && requestOptions.force !== true)) {
      return false
    }
    const range = resolveRequestRange(anchorSec)
    if (
      !requestOptions.force &&
      isRawDataCoveringRange(options.rawData.value, range.visibleStart, range.visibleEnd)
    ) {
      return true
    }
    const nextRequestKey = [filePath, 'full'].join('|')
    if (!requestOptions.force && requestKey === nextRequestKey) {
      return true
    }
    requestKey = nextRequestKey
    const buildToken = ++token
    options.previewLoading.value = true
    if (
      requestOptions.clearIfOutside !== false &&
      !options.rawData.value &&
      !isRawDataCoveringRange(options.rawData.value, range.visibleStart, range.visibleEnd)
    ) {
      clearWaveformShape()
      options.scheduleDraw()
    }
    let data: HorizontalBrowseCompactVisualWaveformWorkerIncoming['payload']['data'] | null = null
    try {
      data = await loadUnifiedDisplayWaveformData(filePath)
    } catch (error: unknown) {
      console.error('[horizontal-browse-compact-strip] load unified display waveform failed', error)
    }
    if (buildToken !== token || (!options.active.value && requestOptions.force !== true)) {
      return false
    }
    if (!data) {
      requestKey = ''
      options.previewLoading.value = false
      clearWaveformShape()
      options.scheduleDraw()
      return false
    }
    postBuild(buildToken, data)
    return true
  }

  const handleWorkerMessage = (
    event: MessageEvent<HorizontalBrowseCompactVisualWaveformWorkerOutgoing>
  ) => {
    const message = event.data
    if (message?.type === 'stripReady') {
      if (message.payload.token !== token) return
      requestKey = ''
      options.previewLoading.value = false
      if (message.payload.data) {
        options.active.value = true
        options.resetPlaybackRenderState()
        options.rawData.value = message.payload.data
        options.mixxxData.value = createRawPlaceholderMixxxData(message.payload.data)
        options.replaceLiveWaveformRaw(message.payload.data)
      } else {
        clearWaveformShape()
      }
      options.scheduleDraw()
      return
    }
    if (message?.type === 'stripFailed') {
      if (message.payload.token !== token) return
      requestKey = ''
      options.previewLoading.value = false
      clearWaveformShape()
      options.scheduleDraw()
    }
  }

  worker.addEventListener('message', handleWorkerMessage)
  worker.addEventListener('error', (event) => {
    const errorEvent = event as ErrorEvent
    console.error('[horizontal-browse-compact-strip-worker] error', {
      message: errorEvent?.message || 'unknown worker error',
      filename: errorEvent?.filename,
      lineno: errorEvent?.lineno,
      colno: errorEvent?.colno
    })
  })

  const handleSongWaveformUpdated = (_event: unknown, payload?: { filePath?: string }) => {
    const currentFilePath = String(options.song()?.filePath || '').trim()
    const updatedFilePath = String(payload?.filePath || '').trim()
    if (
      !currentFilePath ||
      !updatedFilePath ||
      !isSameHorizontalBrowseSongFilePath(currentFilePath, updatedFilePath)
    ) {
      return
    }
    void request(options.resolvePreviewAnchorSec(), { force: true, clearIfOutside: false })
  }

  window.electron.ipcRenderer.on('song-waveform-updated', handleSongWaveformUpdated)

  return {
    clearCompactWaveformShape: clearWaveformShape,
    requestCompactVisualWaveformStrip: request,
    maybeContinueCompactVisualWaveformStrip: (anchorSec?: number) => {
      void request(anchorSec, { clearIfOutside: true })
    },
    resetCompactVisualWaveformStrip: () => {
      token += 1
      requestKey = ''
    },
    disposeCompactVisualWaveformStrip: () => {
      token += 1
      requestKey = ''
      worker.removeEventListener('message', handleWorkerMessage)
      window.electron.ipcRenderer.removeListener('song-waveform-updated', handleSongWaveformUpdated)
      worker.terminate()
    }
  }
}
