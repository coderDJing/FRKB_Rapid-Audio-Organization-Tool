import { ref, onUnmounted, shallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { WebAudioPlayer, type MixxxWaveformData, canPlayHtmlAudio } from './webAudioPlayer'

type WaveformCacheResponse = {
  items?: Array<{ filePath: string; data: MixxxWaveformData | null }>
}

type DecodePayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
}

type LoadOptions = {
  preloadedAudio?: HTMLAudioElement | null
  preloadedBpm?: number | string | null
}

export function useSongLoader(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: ReturnType<typeof shallowRef<WebAudioPlayer | null>>
  bpm: { value: number | string }
  waveformShow: { value: boolean }
  setCoverByIPC: (filePath: string) => void
  onSongBuffered?: (filePath: string, audio: HTMLAudioElement, bpm: number | string | null) => void
}) {
  const { runtime, audioPlayer, bpm, waveformShow, setCoverByIPC, onSongBuffered } = params

  const currentLoadRequestId = ref(0)
  const isLoadingBlob = ref(false)
  const ignoreNextEmptyError = ref(false)

  let errorDialogShowing = false

  const handleSongLoadError = async (filePath: string | null, _isPreload: boolean) => {
    void _isPreload
    if (!filePath || errorDialogShowing) return

    errorDialogShowing = true
    const localFilePath = filePath

    try {
      if (audioPlayer.value && audioPlayer.value.isPlaying()) {
        audioPlayer.value.pause()
      }
      waveformShow.value = false
      bpm.value = 'N/A'

      const res = await confirm({
        title: t('common.error'),
        content: [t('tracks.cannotPlay'), t('tracks.cannotPlayHint')]
      })

      if (res === 'confirm') {
        window.electron.ipcRenderer.send('delSongs', [localFilePath], getCurrentTimeDirName())
        const errorIndex = runtime.playingData.playingSongListData.findIndex(
          (item) => item.filePath === localFilePath
        )
        if (errorIndex !== -1) runtime.playingData.playingSongListData.splice(errorIndex, 1)

        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) {
            audioPlayer.value.empty()
          }
        }

        emitter.emit('songsRemoved', {
          listUUID: runtime.playingData.playingSongListUUID,
          paths: [localFilePath]
        })
      } else {
        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) {
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

  const resolveBpmValue = (preloadedBpmValue?: number | string | null) => {
    if (
      typeof preloadedBpmValue === 'number' &&
      Number.isFinite(preloadedBpmValue) &&
      preloadedBpmValue > 0
    ) {
      bpm.value = preloadedBpmValue
      return true
    }
    const cachedBpm = runtime.playingData.playingSong?.bpm
    if (typeof cachedBpm === 'number' && Number.isFinite(cachedBpm) && cachedBpm > 0) {
      bpm.value = cachedBpm
      return true
    }
    bpm.value = ''
    return false
  }

  const fetchWaveformCache = async (filePath: string, requestId: number) => {
    let response: WaveformCacheResponse | null = null
    try {
      response = await window.electron.ipcRenderer.invoke('waveform-cache:batch', {
        filePaths: [filePath]
      })
    } catch {
      response = null
    }

    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const item = response?.items?.find((entry) => entry.filePath === filePath)
    const data = item?.data ?? null
    const playerInstance = audioPlayer.value
    if (!playerInstance) return
    playerInstance.setMixxxWaveformData(data, filePath)
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
      } catch (playError: any) {
        if (playError?.name !== 'AbortError') {
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

  const handleLoadSong = async (filePath: string, requestId: number, options?: LoadOptions) => {
    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const playerInstance = audioPlayer.value
    if (!playerInstance) return

    setCoverByIPC(filePath)
    waveformShow.value = true
    resolveBpmValue(options?.preloadedBpm ?? null)

    isLoadingBlob.value = true

    const useHtmlPlayback = canPlayHtmlAudio(filePath)
    try {
      playerInstance.setMixxxWaveformData(null, filePath)
      if (useHtmlPlayback) {
        playerInstance.loadFile(filePath, {
          audioElement: options?.preloadedAudio ?? null
        })

        const activeAudio = playerInstance.getAudioElement()
        if (activeAudio) {
          onSongBuffered?.(filePath, activeAudio, bpm.value || null)
        }

        startPlaybackWhenReady(playerInstance, filePath, requestId)

        void fetchWaveformCache(filePath, requestId)
      } else {
        window.electron.ipcRenderer.send('readSongFile', filePath, String(requestId))
      }
    } catch (loadError: any) {
      isLoadingBlob.value = false
      if (loadError?.name !== 'AbortError') {
        await handleSongLoadError(filePath, false)
      }
    }
  }

  const requestLoadSong = (filePath: string, options?: LoadOptions) => {
    const normalized = typeof filePath === 'string' ? filePath.trim() : ''
    if (!normalized) return

    isLoadingBlob.value = false
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) audioPlayer.value.pause()
      ignoreNextEmptyError.value = true
      audioPlayer.value.stop()
    }

    runtime.playerReady = false

    const newRequestId = currentLoadRequestId.value + 1
    currentLoadRequestId.value = newRequestId
    void handleLoadSong(normalized, newRequestId, options)
  }

  const handleWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    void fetchWaveformCache(filePath, currentLoadRequestId.value)
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
      playerInstance.loadPCM({
        pcmData: payload?.pcmData ?? new Float32Array(0),
        sampleRate: payload?.sampleRate ?? 0,
        channels: payload?.channels ?? 1,
        totalFrames: payload?.totalFrames ?? 0,
        mixxxWaveformData: payload?.mixxxWaveformData ?? null,
        filePath
      })
      startPlaybackWhenReady(playerInstance, filePath, requestNumber)
    } catch (error: any) {
      isLoadingBlob.value = false
      if (error?.name !== 'AbortError') {
        void handleSongLoadError(filePath, false)
      }
    }
  }

  const handleReadSongFileError = (
    _event: unknown,
    filePath: string,
    _message: string,
    requestId: string
  ) => {
    const requestNumber = Number(requestId)
    if (!Number.isFinite(requestNumber)) return
    if (requestNumber !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    isLoadingBlob.value = false
    void handleSongLoadError(filePath, false)
  }

  window.electron.ipcRenderer.on('song-waveform-updated', handleWaveformUpdated)
  window.electron.ipcRenderer.on('readedSongFile', handleReadedSongFile)
  window.electron.ipcRenderer.on('readSongFileError', handleReadSongFileError)

  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener('song-waveform-updated', handleWaveformUpdated)
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
