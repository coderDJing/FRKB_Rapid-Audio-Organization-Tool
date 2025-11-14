import { ref, onUnmounted, shallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { WebAudioPlayer } from './webAudioPlayer'

type PcmPayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
}

export function useSongLoader(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: ReturnType<typeof shallowRef<WebAudioPlayer | null>>
  audioContext: AudioContext
  bpm: { value: number | string }
  waveformShow: { value: boolean }
  setCoverByIPC: (filePath: string) => void
  onSongBuffered?: (filePath: string, payload: PcmPayload, bpm: number | string | null) => void
}) {
  const { runtime, audioPlayer, audioContext, bpm, waveformShow, setCoverByIPC, onSongBuffered } =
    params

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
          if (audioPlayer.value) audioPlayer.value.empty()
        }

        emitter.emit('songsRemoved', {
          listUUID: runtime.playingData.playingSongListUUID,
          paths: [localFilePath]
        })
      } else {
        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) audioPlayer.value.empty()
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

  const handleLoadPCM = async (
    pcmData: PcmPayload,
    filePath: string,
    requestId: number,
    preloadedBpmValue?: number | string | null
  ) => {
    if (requestId !== currentLoadRequestId.value) return
    if (isLoadingBlob.value) return
    if (!audioPlayer.value || runtime.playingData.playingSong?.filePath !== filePath) return

    setCoverByIPC(filePath)
    waveformShow.value = true
    let bpmValueAssigned = false
    if (preloadedBpmValue !== undefined && preloadedBpmValue !== null) {
      bpm.value = preloadedBpmValue
      bpmValueAssigned = true
    } else {
      bpm.value = ''
    }

    try {
      isLoadingBlob.value = true

      // 加载 PCM 数据到播放器
      audioPlayer.value.loadPCM(pcmData.pcmData, pcmData.sampleRate, pcmData.channels)

      if (requestId !== currentLoadRequestId.value) {
        isLoadingBlob.value = false
        return
      }
      if (runtime.playingData.playingSong?.filePath !== filePath) {
        isLoadingBlob.value = false
        return
      }

      onSongBuffered?.(filePath, pcmData, preloadedBpmValue ?? null)

      // 计算 BPM（如果未预加载）
      if (!bpmValueAssigned) {
        try {
          // 从 PCM 数据创建 AudioBuffer 用于 BPM 分析
          const audioBuffer = audioContext.createBuffer(
            pcmData.channels,
            pcmData.totalFrames,
            pcmData.sampleRate
          )

          // 将交错 PCM 数据分离到各个声道
          for (let ch = 0; ch < pcmData.channels; ch++) {
            const channelData = audioBuffer.getChannelData(ch)
            for (let i = 0; i < pcmData.totalFrames; i++) {
              channelData[i] = pcmData.pcmData[i * pcmData.channels + ch]
            }
          }

          if (
            requestId === currentLoadRequestId.value &&
            runtime.playingData.playingSong?.filePath === filePath
          ) {
            const { analyzeFullBuffer } = await import('realtime-bpm-analyzer')
            analyzeFullBuffer(audioBuffer).then((topCandidates: any[]) => {
              if (
                requestId === currentLoadRequestId.value &&
                runtime.playingData.playingSong?.filePath === filePath
              ) {
                const analyzedBpm = topCandidates[0]?.tempo ?? 'N/A'
                bpm.value = analyzedBpm
                onSongBuffered?.(filePath, pcmData, analyzedBpm)
              }
            })
          }
        } catch (_) {
          if (
            requestId === currentLoadRequestId.value &&
            runtime.playingData.playingSong?.filePath === filePath
          ) {
            bpm.value = 'N/A'
            onSongBuffered?.(filePath, pcmData, 'N/A')
          }
        }
      }

      // 开始播放
      try {
        const reqIdToPlay = requestId
        if (reqIdToPlay !== currentLoadRequestId.value) return
        if (runtime.setting.enablePlaybackRange && audioPlayer.value) {
          const duration = audioPlayer.value.getDuration()
          const startPercent = runtime.setting.startPlayPercent ?? 0
          const startTime = (duration * startPercent) / 100
          audioPlayer.value.play(startTime)
        } else {
          audioPlayer.value?.play()
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
    pcmData: { pcmData: Float32Array; sampleRate: number; channels: number; totalFrames: number },
    filePath: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== currentLoadRequestId.value) return
    if (filePath === runtime.playingData.playingSong?.filePath) {
      handleLoadPCM(pcmData, filePath, requestId || currentLoadRequestId.value)
    }
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
