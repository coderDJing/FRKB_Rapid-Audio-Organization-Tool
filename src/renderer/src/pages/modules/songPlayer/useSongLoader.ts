import { ref, onUnmounted, shallowRef } from 'vue'
import type WaveSurfer from 'wavesurfer.js'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'

export function useSongLoader(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  wavesurferInstance: ReturnType<typeof shallowRef<WaveSurfer | null>>
  audioContext: AudioContext
  bpm: { value: number | string }
  waveformShow: { value: boolean }
  setCoverByIPC: (filePath: string) => void
}) {
  const { runtime, wavesurferInstance, audioContext, bpm, waveformShow, setCoverByIPC } = params

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
      if (wavesurferInstance.value && wavesurferInstance.value.isPlaying()) {
        wavesurferInstance.value.pause()
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
          if (wavesurferInstance.value) wavesurferInstance.value.empty()
        }

        emitter.emit('songsRemoved', {
          listUUID: runtime.playingData.playingSongListUUID,
          paths: [localFilePath]
        })
      } else {
        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (wavesurferInstance.value) wavesurferInstance.value.empty()
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
    const lower = (filePath || '').toLowerCase()
    if (lower.endsWith('.aif') || lower.endsWith('.aiff')) {
      return
    }

    isLoadingBlob.value = false
    if (wavesurferInstance.value) {
      if (wavesurferInstance.value.isPlaying()) wavesurferInstance.value.pause()
      ignoreNextEmptyError.value = true
      wavesurferInstance.value.empty()
    }

    runtime.playerReady = false

    const newRequestId = currentLoadRequestId.value + 1
    currentLoadRequestId.value = newRequestId
    window.electron.ipcRenderer.send('readSongFile', filePath, newRequestId)
  }

  const handleLoadBlob = async (
    blob: Blob,
    filePath: string,
    requestId: number,
    preloadedBpmValue?: number | string | null
  ) => {
    if (requestId !== currentLoadRequestId.value) return
    if (isLoadingBlob.value) return
    if (!wavesurferInstance.value || runtime.playingData.playingSong?.filePath !== filePath) return

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
      await wavesurferInstance.value.loadBlob(blob)
      if (requestId !== currentLoadRequestId.value) {
        isLoadingBlob.value = false
        return
      }
      if (runtime.playingData.playingSong?.filePath !== filePath) {
        isLoadingBlob.value = false
        return
      }

      if (!bpmValueAssigned) {
        blob
          .arrayBuffer()
          .then(async (arrayBuffer) => {
            if (
              requestId !== currentLoadRequestId.value ||
              runtime.playingData.playingSong?.filePath !== filePath
            )
              return
            try {
              const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
              if (
                requestId !== currentLoadRequestId.value ||
                runtime.playingData.playingSong?.filePath !== filePath
              )
                return
              const { analyzeFullBuffer } = await import('realtime-bpm-analyzer')
              analyzeFullBuffer(audioBuffer).then((topCandidates: any[]) => {
                if (
                  requestId === currentLoadRequestId.value &&
                  runtime.playingData.playingSong?.filePath === filePath
                ) {
                  bpm.value = topCandidates[0]?.tempo ?? 'N/A'
                }
              })
            } catch (_) {
              if (
                requestId === currentLoadRequestId.value &&
                runtime.playingData.playingSong?.filePath === filePath
              ) {
                bpm.value = 'N/A'
              }
            }
          })
          .catch(() => {
            if (
              requestId === currentLoadRequestId.value &&
              runtime.playingData.playingSong?.filePath === filePath
            ) {
              bpm.value = 'N/A'
            }
          })
      }

      try {
        const reqIdToPlay = requestId
        if (reqIdToPlay !== currentLoadRequestId.value) return
        if (runtime.setting.enablePlaybackRange && wavesurferInstance.value) {
          const duration = wavesurferInstance.value.getDuration()
          const startPercent = runtime.setting.startPlayPercent ?? 0
          const startTime = (duration * startPercent) / 100
          wavesurferInstance.value.play(startTime)
        } else {
          wavesurferInstance.value?.play()
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
    audioData: Uint8Array,
    filePath: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== currentLoadRequestId.value) return
    if (filePath === runtime.playingData.playingSong?.filePath) {
      const ab = audioData.buffer.slice(
        audioData.byteOffset,
        audioData.byteOffset + audioData.byteLength
      ) as ArrayBuffer
      handleLoadBlob(new Blob([ab]), filePath, requestId || currentLoadRequestId.value)
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
    handleLoadBlob,
    handleSongLoadError
  }
}
