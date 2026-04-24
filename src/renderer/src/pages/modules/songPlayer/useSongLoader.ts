import { ref, onBeforeUnmount, shallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  getRekordboxPreviewWaveformRequestChannel,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import { WebAudioPlayer, type MixxxWaveformData, canPlayHtmlAudio } from './webAudioPlayer'
import libraryUtils from '@renderer/utils/libraryUtils'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { resolvePlayerWaveformTraceElapsedMs, sendPlayerWaveformTrace } from './playerWaveformTrace'

type WaveformCacheResponse = {
  items?: Array<{ filePath: string; data: MixxxWaveformData | null }>
}

type PioneerPreviewWaveformResponse = {
  items?: Array<{ analyzePath: string; data: IPioneerPreviewWaveformData | null }>
}

type RawWaveformStreamChunkPayload = {
  requestId?: string
  filePath?: string
  startFrame?: number
  frames?: number
  totalFrames?: number
  duration?: number
  sampleRate?: number
  rate?: number
  minLeft?: unknown
  maxLeft?: unknown
  minRight?: unknown
  maxRight?: unknown
}

type RawWaveformStreamDonePayload = {
  requestId?: string
  filePath?: string
  data?: unknown
  duration?: unknown
  totalFrames?: unknown
  error?: string
}

type DecodePayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
}

const PLAYER_RAW_WAVEFORM_TARGET_RATE = 4800
const PLAYER_RAW_WAVEFORM_CHUNK_FRAMES = 32768
const PLAYER_RAW_WAVEFORM_PRIORITY_HINT = 1000

const normalizeSongPathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

const toFloat32Array = (value: unknown) => {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

const normalizeRawWaveformData = (value: unknown): RawWaveformData | null => {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!payload) return null

  const frames = Math.max(0, Number((payload as RawWaveformData).frames) || 0)
  const duration = Math.max(0, Number((payload as RawWaveformData).duration) || 0)
  const sampleRate = Math.max(0, Number((payload as RawWaveformData).sampleRate) || 0)
  const rate = Math.max(0, Number((payload as RawWaveformData).rate) || 0)
  const minLeft = toFloat32Array((payload as RawWaveformData).minLeft)
  const maxLeft = toFloat32Array((payload as RawWaveformData).maxLeft)
  const minRight = toFloat32Array((payload as RawWaveformData).minRight)
  const maxRight = toFloat32Array((payload as RawWaveformData).maxRight)
  if (!frames || !duration || !sampleRate || !rate) return null

  return {
    duration,
    sampleRate,
    rate,
    frames,
    loadedFrames: frames,
    minLeft: new Float32Array(minLeft),
    maxLeft: new Float32Array(maxLeft),
    minRight: new Float32Array(minRight),
    maxRight: new Float32Array(maxRight)
  }
}

export function useSongLoader(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: ReturnType<typeof shallowRef<WebAudioPlayer | null>>
  rawWaveformData: { value: RawWaveformData | null }
  bpm: { value: number | string }
  waveformShow: { value: boolean }
  setCoverByIPC: (filePath: string) => void
}) {
  const { runtime, audioPlayer, rawWaveformData, bpm, waveformShow, setCoverByIPC } = params
  const isAbortError = (error: unknown) =>
    error instanceof Error ? error.name === 'AbortError' : false

  const currentLoadRequestId = ref(0)
  const isLoadingBlob = ref(false)
  const ignoreNextEmptyError = ref(false)
  let rawWaveformStreamRequestId = ''
  let waveformTraceStartedAt = 0
  let rawWaveformChunkCount = 0

  let errorDialogShowing = false
  const handleSongLoadError = async (
    filePath: string | null,
    _isPreload: boolean,
    errorMessage?: string
  ) => {
    void _isPreload
    if (!filePath || errorDialogShowing) return

    errorDialogShowing = true
    const localFilePath = filePath

    try {
      if (audioPlayer.value && audioPlayer.value.isPlaying()) {
        audioPlayer.value.pause()
      }
      cancelRawWaveformStream()
      rawWaveformData.value = null
      waveformShow.value = false
      bpm.value = 'N/A'

      // 记录错误到控制台
      console.error('[播放失败]', filePath, errorMessage || '未知错误')

      const content = errorMessage
        ? [t('tracks.cannotPlay'), errorMessage, t('tracks.cannotPlayHint')]
        : [t('tracks.cannotPlay'), t('tracks.cannotPlayHint')]

      const res = await confirm({
        title: t('common.error'),
        content
      })

      if (res === 'confirm') {
        const currentListUUID = runtime.playingData.playingSongListUUID
        const isRecycleBinView = currentListUUID === RECYCLE_BIN_UUID
        const isExternalView = currentListUUID === EXTERNAL_PLAYLIST_UUID
        let removedPathsForEvent = [localFilePath]
        if (isRecycleBinView) {
          const summary = await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
            localFilePath
          ])
          const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
          removedPathsForEvent = removedPaths
        } else {
          const payload = isExternalView
            ? { filePaths: [localFilePath], sourceType: 'external' }
            : (() => {
                const songListPath = libraryUtils.findDirPathByUuid(currentListUUID)
                return songListPath ? { filePaths: [localFilePath], songListPath } : [localFilePath]
              })()
          window.electron.ipcRenderer.send('delSongs', payload)
        }
        const errorIndex = runtime.playingData.playingSongListData.findIndex(
          (item) => item.filePath === localFilePath
        )
        if (errorIndex !== -1) runtime.playingData.playingSongListData.splice(errorIndex, 1)

        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) {
            ignoreNextEmptyError.value = true
            audioPlayer.value.empty()
          }
        }

        if (removedPathsForEvent.length > 0) {
          emitter.emit('songsRemoved', {
            listUUID: currentListUUID,
            paths: removedPathsForEvent
          })
        }
      } else {
        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) {
            ignoreNextEmptyError.value = true
            audioPlayer.value.empty()
          }
          waveformShow.value = false
        }
      }
    } catch (e) {
      // 忽略
    } finally {
      errorDialogShowing = false
    }
  }

  const resolveBpmValue = () => {
    const cachedBpm = runtime.playingData.playingSong?.bpm
    if (typeof cachedBpm === 'number' && Number.isFinite(cachedBpm) && cachedBpm > 0) {
      bpm.value = cachedBpm
      return true
    }
    bpm.value = ''
    return false
  }

  const tracePlayerWaveform = (
    scope: string,
    stage: string,
    filePath?: string | null,
    payload?: Record<string, unknown>
  ) => {
    sendPlayerWaveformTrace(scope, stage, {
      requestId: currentLoadRequestId.value,
      filePath: typeof filePath === 'string' ? filePath : runtime.playingData.playingSong?.filePath,
      elapsedMs: resolvePlayerWaveformTraceElapsedMs(waveformTraceStartedAt),
      ...payload
    })
  }

  const cancelRawWaveformStream = () => {
    const requestId = rawWaveformStreamRequestId
    rawWaveformStreamRequestId = ''
    if (!requestId) return
    tracePlayerWaveform('loader', 'raw-stream:cancel', undefined, { streamRequestId: requestId })
    window.electron.ipcRenderer.send('mixtape-waveform-raw:cancel-stream', { requestId })
  }

  const ensureRawWaveformCapacity = (
    requiredFrames: number,
    meta: { duration: number; sampleRate: number; rate: number }
  ) => {
    const nextFrames = Math.max(0, Math.floor(requiredFrames))
    if (!nextFrames) return null

    const current = rawWaveformData.value
    if (!current) {
      return {
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        rate: meta.rate,
        frames: nextFrames,
        loadedFrames: 0,
        minLeft: new Float32Array(nextFrames),
        maxLeft: new Float32Array(nextFrames),
        minRight: new Float32Array(nextFrames),
        maxRight: new Float32Array(nextFrames)
      }
    }

    if (
      current.frames >= nextFrames &&
      current.sampleRate === meta.sampleRate &&
      current.rate === meta.rate &&
      Math.abs(current.duration - meta.duration) <= 0.0001
    ) {
      return current
    }

    const grownFrames = Math.max(current.frames, nextFrames)
    const grow = (source: Float32Array) => {
      const target = new Float32Array(grownFrames)
      target.set(source.subarray(0, Math.min(source.length, grownFrames)))
      return target
    }

    return {
      duration: Math.max(current.duration, meta.duration),
      sampleRate: meta.sampleRate,
      rate: meta.rate,
      frames: grownFrames,
      loadedFrames: current.loadedFrames,
      minLeft: grow(current.minLeft),
      maxLeft: grow(current.maxLeft),
      minRight: grow(current.minRight),
      maxRight: grow(current.maxRight)
    }
  }

  const startRawWaveformStream = (filePath: string, requestId: number) => {
    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    cancelRawWaveformStream()
    rawWaveformData.value = null
    rawWaveformChunkCount = 0
    rawWaveformStreamRequestId = `player-raw-waveform-${requestId}-${Date.now()}`
    tracePlayerWaveform('loader', 'raw-stream:start', filePath, {
      streamRequestId: rawWaveformStreamRequestId,
      targetRate: PLAYER_RAW_WAVEFORM_TARGET_RATE,
      chunkFrames: PLAYER_RAW_WAVEFORM_CHUNK_FRAMES
    })
    window.electron.ipcRenderer.send('mixtape-waveform-raw:stream', {
      requestId: rawWaveformStreamRequestId,
      filePath,
      targetRate: PLAYER_RAW_WAVEFORM_TARGET_RATE,
      chunkFrames: PLAYER_RAW_WAVEFORM_CHUNK_FRAMES,
      priorityHint: PLAYER_RAW_WAVEFORM_PRIORITY_HINT
    })
  }

  const fetchWaveformCache = async (filePath: string, requestId: number) => {
    let response: WaveformCacheResponse | null = null
    tracePlayerWaveform('loader', 'formal-cache:query-start', filePath)
    try {
      response = await window.electron.ipcRenderer.invoke('waveform-cache:batch', {
        filePaths: [filePath]
      })
    } catch {
      response = null
    }

    if (requestId !== currentLoadRequestId.value) return false
    if (runtime.playingData.playingSong?.filePath !== filePath) return false

    const item = response?.items?.find((entry) => entry.filePath === filePath)
    const data = item?.data ?? null
    const playerInstance = audioPlayer.value
    if (!playerInstance) return false
    if (!data) {
      tracePlayerWaveform('loader', 'formal-cache:miss', filePath)
      return false
    }
    cancelRawWaveformStream()
    rawWaveformData.value = null
    playerInstance.setMixxxWaveformData(data, filePath)
    tracePlayerWaveform('loader', 'formal-cache:hit', filePath, {
      duration: Number(data.duration || 0),
      sampleRate: Number(data.sampleRate || 0),
      step: Number(data.step || 0)
    })
    return true
  }

  const fetchPioneerPreviewWaveform = async (
    filePath: string,
    sourceKind: 'usb' | 'desktop',
    rootPath: string,
    analyzePath: string,
    requestId: number
  ) => {
    let response: PioneerPreviewWaveformResponse | null = null
    try {
      response = await window.electron.ipcRenderer.invoke(
        getRekordboxPreviewWaveformRequestChannel(sourceKind),
        rootPath,
        [analyzePath]
      )
    } catch {
      response = null
    }

    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const item = response?.items?.find((entry) => entry.analyzePath === analyzePath)
    const data = item?.data ?? null
    const playerInstance = audioPlayer.value
    if (!playerInstance) return
    cancelRawWaveformStream()
    rawWaveformData.value = null
    playerInstance.setPioneerPreviewWaveformData(data)
    tracePlayerWaveform(
      'loader',
      data ? 'pioneer-preview:ready' : 'pioneer-preview:miss',
      filePath,
      {
        sourceKind,
        analyzePath
      }
    )
  }

  const startPlaybackWhenReady = (
    playerInstance: WebAudioPlayer,
    filePath: string,
    requestId: number
  ) => {
    const startPlay = () => {
      if (requestId !== currentLoadRequestId.value) return
      if (runtime.playingData.playingSong?.filePath !== filePath) return
      const duration = playerInstance.getDuration()
      let startTime = 0
      if (runtime.setting.enablePlaybackRange && duration > 0) {
        const startPercent = runtime.setting.startPlayPercent ?? 0
        const startValue =
          typeof startPercent === 'number' ? startPercent : parseFloat(String(startPercent))
        const safePercent = Number.isFinite(startValue) ? startValue : 0
        startTime = (duration * Math.min(Math.max(safePercent, 0), 100)) / 100
      }
      try {
        playerInstance.play(startTime)
      } catch (playError: unknown) {
        if (!isAbortError(playError)) {
          void handleSongLoadError(filePath, false)
        }
      } finally {
        isLoadingBlob.value = false
      }
    }

    if (playerInstance.isReady()) {
      startPlay()
      return
    }

    playerInstance.once('ready', startPlay)
  }

  const handleLoadSong = async (filePath: string, requestId: number) => {
    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const playerInstance = audioPlayer.value
    if (!playerInstance) return

    setCoverByIPC(filePath)
    waveformShow.value = true
    resolveBpmValue()
    cancelRawWaveformStream()
    rawWaveformData.value = null
    playerInstance.setPioneerPreviewWaveformData(null)

    isLoadingBlob.value = true

    const useHtmlPlayback = canPlayHtmlAudio(filePath)
    const currentSong = runtime.playingData.playingSong
    const externalWaveformSource = resolveSongExternalWaveformSource(currentSong, {
      rootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
      sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
    })
    tracePlayerWaveform('loader', 'load:start', filePath, {
      useHtmlPlayback,
      hasExternalWaveformSource: Boolean(externalWaveformSource)
    })
    try {
      playerInstance.setMixxxWaveformData(null, filePath)
      if (useHtmlPlayback) {
        playerInstance.loadFile(filePath)

        startPlaybackWhenReady(playerInstance, filePath, requestId)

        if (externalWaveformSource) {
          void fetchPioneerPreviewWaveform(
            filePath,
            externalWaveformSource.sourceKind,
            externalWaveformSource.rootPath,
            externalWaveformSource.analyzePath,
            requestId
          )
        } else {
          void (async () => {
            const hasCachedWaveform = await fetchWaveformCache(filePath, requestId)
            if (hasCachedWaveform) return
            if (requestId !== currentLoadRequestId.value) return
            if (runtime.playingData.playingSong?.filePath !== filePath) return
            tracePlayerWaveform('loader', 'formal-cache:queue-generation', filePath)
            window.electron.ipcRenderer.send('key-analysis:queue-playing', { filePath })
            startRawWaveformStream(filePath, requestId)
          })()
        }
      } else {
        tracePlayerWaveform('loader', 'pcm-decode:request', filePath)
        window.electron.ipcRenderer.send('readSongFile', filePath, String(requestId))
      }
    } catch (loadError: unknown) {
      isLoadingBlob.value = false
      if (!isAbortError(loadError)) {
        await handleSongLoadError(filePath, false)
      }
    }
  }

  const requestLoadSong = (filePath: string) => {
    const normalized = typeof filePath === 'string' ? filePath.trim() : ''
    if (!normalized) return

    cancelRawWaveformStream()
    rawWaveformData.value = null
    isLoadingBlob.value = false
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) audioPlayer.value.pause()
      ignoreNextEmptyError.value = true
      audioPlayer.value.stop()
    }

    runtime.playerReady = false

    const newRequestId = currentLoadRequestId.value + 1
    currentLoadRequestId.value = newRequestId
    waveformTraceStartedAt = performance.now()
    rawWaveformChunkCount = 0
    tracePlayerWaveform('loader', 'request-load', normalized)
    void handleLoadSong(normalized, newRequestId)
  }

  const handleWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    tracePlayerWaveform('loader', 'formal-cache:updated-event', filePath)
    void fetchWaveformCache(filePath, currentLoadRequestId.value)
  }

  const handleRawWaveformStreamChunk = (
    _event: unknown,
    payload?: RawWaveformStreamChunkPayload
  ) => {
    if (String(payload?.requestId || '') !== rawWaveformStreamRequestId) return
    if (
      normalizeSongPathKey(payload?.filePath) !==
      normalizeSongPathKey(runtime.playingData.playingSong?.filePath)
    ) {
      return
    }

    const totalFrames = Math.max(0, Number(payload?.totalFrames) || 0)
    const duration = Math.max(0, Number(payload?.duration) || 0)
    const sampleRate = Math.max(0, Number(payload?.sampleRate) || 0)
    const rate = Math.max(0, Number(payload?.rate) || 0)
    const startFrame = Math.max(0, Number(payload?.startFrame) || 0)
    const frames = Math.max(0, Number(payload?.frames) || 0)
    if (!totalFrames || !duration || !sampleRate || !rate || !frames) return

    const target = ensureRawWaveformCapacity(Math.max(totalFrames, startFrame + frames), {
      duration,
      sampleRate,
      rate
    })
    if (!target) return

    const minLeftChunk = toFloat32Array(payload?.minLeft)
    const maxLeftChunk = toFloat32Array(payload?.maxLeft)
    const minRightChunk = toFloat32Array(payload?.minRight)
    const maxRightChunk = toFloat32Array(payload?.maxRight)
    const chunkFrames = Math.min(
      frames,
      minLeftChunk.length,
      maxLeftChunk.length,
      minRightChunk.length,
      maxRightChunk.length
    )
    if (!chunkFrames || startFrame + chunkFrames > target.minLeft.length) return

    target.minLeft.set(minLeftChunk.subarray(0, chunkFrames), startFrame)
    target.maxLeft.set(maxLeftChunk.subarray(0, chunkFrames), startFrame)
    target.minRight.set(minRightChunk.subarray(0, chunkFrames), startFrame)
    target.maxRight.set(maxRightChunk.subarray(0, chunkFrames), startFrame)
    const loadedFrames = Math.max(startFrame + chunkFrames, Number(target.loadedFrames) || 0)
    rawWaveformData.value = {
      ...target,
      duration,
      sampleRate,
      rate,
      frames: target.frames,
      loadedFrames
    }
    rawWaveformChunkCount += 1
    if (rawWaveformChunkCount === 1) {
      tracePlayerWaveform('loader', 'raw-stream:first-chunk', String(payload?.filePath || ''), {
        streamRequestId: rawWaveformStreamRequestId,
        startFrame,
        frames: chunkFrames,
        totalFrames,
        loadedFrames
      })
    }
  }

  const handleRawWaveformStreamDone = (_event: unknown, payload?: RawWaveformStreamDonePayload) => {
    if (String(payload?.requestId || '') !== rawWaveformStreamRequestId) return
    if (
      normalizeSongPathKey(payload?.filePath) !==
      normalizeSongPathKey(runtime.playingData.playingSong?.filePath)
    ) {
      return
    }

    rawWaveformStreamRequestId = ''
    const normalized = normalizeRawWaveformData(payload?.data)
    if (normalized) {
      rawWaveformData.value = normalized
      tracePlayerWaveform('loader', 'raw-stream:done', String(payload?.filePath || ''), {
        streamRequestId: String(payload?.requestId || ''),
        error: payload?.error,
        totalFrames: normalized.frames,
        loadedFrames: normalized.loadedFrames ?? normalized.frames
      })
      return
    }

    if (!rawWaveformData.value) return
    const duration = Math.max(0, Number(payload?.duration) || 0)
    const totalFrames = Math.max(0, Number(payload?.totalFrames) || 0)
    rawWaveformData.value = {
      ...rawWaveformData.value,
      duration: duration > 0 ? duration : rawWaveformData.value.duration,
      loadedFrames:
        totalFrames > 0
          ? totalFrames
          : (rawWaveformData.value.loadedFrames ?? rawWaveformData.value.frames),
      frames:
        totalFrames > 0 && totalFrames <= rawWaveformData.value.frames
          ? totalFrames
          : rawWaveformData.value.frames
    }
    tracePlayerWaveform('loader', 'raw-stream:done', String(payload?.filePath || ''), {
      streamRequestId: String(payload?.requestId || ''),
      error: payload?.error,
      totalFrames: rawWaveformData.value.frames,
      loadedFrames: rawWaveformData.value.loadedFrames ?? rawWaveformData.value.frames
    })
  }

  const handleReadedSongFile = (
    _event: unknown,
    payload: DecodePayload,
    filePath: string,
    requestId: string
  ) => {
    const requestNumber = Number(requestId)
    if (!Number.isFinite(requestNumber)) return
    if (requestNumber !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const playerInstance = audioPlayer.value
    if (!playerInstance) return

    try {
      cancelRawWaveformStream()
      rawWaveformData.value = null
      playerInstance.loadPCM({
        pcmData: payload?.pcmData ?? new Float32Array(0),
        sampleRate: payload?.sampleRate ?? 0,
        channels: payload?.channels ?? 1,
        totalFrames: payload?.totalFrames ?? 0,
        mixxxWaveformData: payload?.mixxxWaveformData ?? null,
        filePath
      })
      tracePlayerWaveform('loader', 'pcm-decode:ready', filePath, {
        sampleRate: Number(payload?.sampleRate || 0),
        channels: Number(payload?.channels || 0),
        totalFrames: Number(payload?.totalFrames || 0),
        hasFormalWaveform: Boolean(payload?.mixxxWaveformData)
      })
      startPlaybackWhenReady(playerInstance, filePath, requestNumber)
    } catch (error: unknown) {
      isLoadingBlob.value = false
      if (!isAbortError(error)) {
        void handleSongLoadError(filePath, false)
      }
    }
  }

  const handleReadSongFileError = (
    _event: unknown,
    filePath: string,
    message: string,
    requestId: string
  ) => {
    const requestNumber = Number(requestId)
    if (!Number.isFinite(requestNumber)) return
    if (requestNumber !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    isLoadingBlob.value = false
    void handleSongLoadError(filePath, false, message)
  }

  window.electron.ipcRenderer.on('song-waveform-updated', handleWaveformUpdated)
  window.electron.ipcRenderer.on('mixtape-waveform-raw:stream-chunk', handleRawWaveformStreamChunk)
  window.electron.ipcRenderer.on('mixtape-waveform-raw:stream-done', handleRawWaveformStreamDone)
  window.electron.ipcRenderer.on('readedSongFile', handleReadedSongFile)
  window.electron.ipcRenderer.on('readSongFileError', handleReadSongFileError)

  onBeforeUnmount(() => {
    cancelRawWaveformStream()
    window.electron.ipcRenderer.removeListener('song-waveform-updated', handleWaveformUpdated)
    window.electron.ipcRenderer.removeListener(
      'mixtape-waveform-raw:stream-chunk',
      handleRawWaveformStreamChunk
    )
    window.electron.ipcRenderer.removeListener(
      'mixtape-waveform-raw:stream-done',
      handleRawWaveformStreamDone
    )
    window.electron.ipcRenderer.removeListener('readedSongFile', handleReadedSongFile)
    window.electron.ipcRenderer.removeListener('readSongFileError', handleReadSongFileError)
  })

  return {
    currentLoadRequestId,
    isLoadingBlob,
    ignoreNextEmptyError,
    requestLoadSong,
    handleSongLoadError
  }
}
