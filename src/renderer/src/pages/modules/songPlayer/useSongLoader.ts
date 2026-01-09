import { ref, onUnmounted, shallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { WebAudioPlayer, type MixxxWaveformData } from './webAudioPlayer'

type PcmPayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
}
type SongFilePayload = PcmPayload & {
  metaOnly?: boolean
  durationMs?: number
  fileSize?: number
  skipDecode?: boolean
  discardAfterDecode?: boolean
}

export function useSongLoader(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: ReturnType<typeof shallowRef<WebAudioPlayer | null>>
  bpm: { value: number | string }
  waveformShow: { value: boolean }
  setCoverByIPC: (filePath: string) => void
  onSongBuffered?: (filePath: string, payload: PcmPayload, bpm: number | string | null) => void
}) {
  const { runtime, audioPlayer, bpm, waveformShow, setCoverByIPC, onSongBuffered } = params

  const currentLoadRequestId = ref(0)
  const isLoadingBlob = ref(false)
  const ignoreNextEmptyError = ref(false)

  let errorDialogShowing = false

  const handleSongLoadError = async (filePath: string | null, isPreload: boolean) => {
    // 预加载错误不在此处理
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

  const requestLoadSong = (filePath: string) => {
    isLoadingBlob.value = false
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) audioPlayer.value.pause()
      ignoreNextEmptyError.value = true
      audioPlayer.value.empty()
    }

    runtime.playerReady = false

    const newRequestId = currentLoadRequestId.value + 1
    currentLoadRequestId.value = newRequestId
    window.electron.ipcRenderer.send('readSongFile', filePath, newRequestId)
  }

  const handleMetadataOnlyResponse = (
    filePath: string,
    payload?: {
      durationMs?: number
      requestId?: number
      fileSize?: number
      skipDecode?: boolean
      discardAfterDecode?: boolean
    }
  ) => {
    waveformShow.value = false
    bpm.value = ''
    runtime.playerReady = false
    runtime.isSwitchingSong = false
    isLoadingBlob.value = false
  }

  const handleLoadPCM = async (
    pcmData: SongFilePayload,
    filePath: string,
    requestId: number,
    preloadedBpmValue?: number | string | null
  ) => {
    if (requestId !== currentLoadRequestId.value) return
    if (isLoadingBlob.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    if (pcmData.metaOnly) {
      setCoverByIPC(filePath)
      handleMetadataOnlyResponse(filePath, {
        durationMs: pcmData.durationMs,
        requestId,
        fileSize: (pcmData as any).fileSize,
        skipDecode: Boolean((pcmData as any).skipDecode),
        discardAfterDecode: Boolean((pcmData as any).discardAfterDecode)
      })
      return
    }

    const playerInstance = audioPlayer.value
    if (!playerInstance) return

    setCoverByIPC(filePath)
    waveformShow.value = true
    let bpmValueAssigned = false
    if (
      typeof preloadedBpmValue === 'number' &&
      Number.isFinite(preloadedBpmValue) &&
      preloadedBpmValue > 0
    ) {
      bpm.value = preloadedBpmValue
      bpmValueAssigned = true
    } else {
      const cachedBpm = runtime.playingData.playingSong?.bpm
      if (typeof cachedBpm === 'number' && Number.isFinite(cachedBpm) && cachedBpm > 0) {
        bpm.value = cachedBpm
        bpmValueAssigned = true
      } else {
        bpm.value = ''
      }
    }

    try {
      isLoadingBlob.value = true

      // 加载 PCM 数据到播放器
      playerInstance.loadPCM(pcmData.pcmData, pcmData.sampleRate, pcmData.channels, {
        filePath,
        mixxxWaveformData: pcmData.mixxxWaveformData ?? null
      })

      if (requestId !== currentLoadRequestId.value) {
        isLoadingBlob.value = false
        return
      }
      if (runtime.playingData.playingSong?.filePath !== filePath) {
        isLoadingBlob.value = false
        return
      }

      onSongBuffered?.(filePath, pcmData, bpmValueAssigned ? bpm.value : null)

      const duration = playerInstance.getDuration()

      // 开始播放
      try {
        const reqIdToPlay = requestId
        if (reqIdToPlay !== currentLoadRequestId.value) return
        if (runtime.setting.enablePlaybackRange) {
          const startPercent = runtime.setting.startPlayPercent ?? 0
          const startTime = (duration * startPercent) / 100
          playerInstance.play(startTime)
        } else {
          playerInstance.play()
        }
      } catch (playError: any) {
        if (playError?.name !== 'AbortError') {
          await handleSongLoadError(filePath, false)
        }
      }
    } catch (loadError: any) {
      if (loadError?.name !== 'AbortError') {
        await handleSongLoadError(filePath, false)
      }
    } finally {
      isLoadingBlob.value = false
    }
  }

  const onReadedSongFile = (
    event: any,
    pcmData: SongFilePayload,
    filePath: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== currentLoadRequestId.value) return
    if (filePath !== runtime.playingData.playingSong?.filePath) {
      return
    }
    if (pcmData.metaOnly) {
      setCoverByIPC(filePath)
      handleMetadataOnlyResponse(filePath, {
        durationMs: pcmData.durationMs,
        requestId,
        fileSize: (pcmData as any).fileSize,
        skipDecode: Boolean((pcmData as any).skipDecode),
        discardAfterDecode: Boolean((pcmData as any).discardAfterDecode)
      })
      return
    }
    handleLoadPCM(pcmData, filePath, requestId || currentLoadRequestId.value)
  }

  const onReadSongFileError = (
    event: any,
    filePath: string,
    errorMessage: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== currentLoadRequestId.value) return
    handleSongLoadError(filePath, false)
  }

  window.electron.ipcRenderer.on('readedSongFile', onReadedSongFile)
  window.electron.ipcRenderer.on('readSongFileError', onReadSongFileError)

  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener('readedSongFile', onReadedSongFile)
    window.electron.ipcRenderer.removeListener('readSongFileError', onReadSongFileError)
  })

  return {
    currentLoadRequestId,
    isLoadingBlob,
    ignoreNextEmptyError,
    requestLoadSong,
    handleLoadPCM,
    handleSongLoadError
  }
}
