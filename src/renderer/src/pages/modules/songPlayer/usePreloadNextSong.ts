import { ref, onUnmounted } from 'vue'
import * as realtimeBpm from 'realtime-bpm-analyzer'
import { useRuntimeStore } from '@renderer/stores/runtime'

export function usePreloadNextSong(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioContext: AudioContext
}) {
  const { runtime, audioContext } = params

  const isPreloading = ref(false)
  const isPreloadReady = ref(false)
  const preloadedBlob = ref<Blob | null>(null)
  const preloadedSongFilePath = ref<string | null>(null)
  const preloadedBpm = ref<number | string | null>(null)
  const currentPreloadRequestId = ref(0)

  let preloadTimerId: any = null

  const cancelPreloadTimer = () => {
    if (preloadTimerId !== null) {
      clearTimeout(preloadTimerId)
      preloadTimerId = null
    }

    if (isPreloading.value) {
      isPreloading.value = false
      isPreloadReady.value = false
      preloadedBlob.value = null
      preloadedBpm.value = null
      preloadedSongFilePath.value = null
    }
  }

  const clearReadyPreloadState = () => {
    if (isPreloadReady.value || isPreloading.value) {
      isPreloading.value = false
      isPreloadReady.value = false
      preloadedBlob.value = null
      preloadedBpm.value = null
      preloadedSongFilePath.value = null
    }
  }

  const schedulePreloadAfterPlay = () => {
    cancelPreloadTimer()
    preloadTimerId = setTimeout(() => {
      const timerId = preloadTimerId
      preloadNextSong()
      if (preloadTimerId === timerId) preloadTimerId = null
    }, 3000)
  }

  const handleSongLoadError = (filePath: string | null) => {
    // 预加载失败仅清理状态，不弹窗
    isPreloading.value = false
    isPreloadReady.value = false
    preloadedBlob.value = null
    preloadedSongFilePath.value = null
  }

  const preloadNextSong = () => {
    if (isPreloading.value || !runtime.playingData.playingSong) return

    const currentIndex = runtime.playingData.playingSongListData.findIndex(
      (item) => item.filePath === runtime.playingData.playingSong?.filePath
    )
    if (currentIndex === -1 || currentIndex >= runtime.playingData.playingSongListData.length - 1) {
      return
    }

    let scanIndex = currentIndex + 1
    let nextSongToPreload = runtime.playingData.playingSongListData[scanIndex]
    while (nextSongToPreload) {
      const p = (nextSongToPreload.filePath || '').toLowerCase()
      if (!(p.endsWith('.aif') || p.endsWith('.aiff'))) break
      scanIndex++
      nextSongToPreload = runtime.playingData.playingSongListData[scanIndex]
    }
    if (!nextSongToPreload?.filePath) {
      return
    }

    const nextSongFilePath = nextSongToPreload.filePath
    if (nextSongFilePath === preloadedSongFilePath.value && isPreloadReady.value) return

    clearReadyPreloadState()
    preloadedSongFilePath.value = nextSongFilePath
    isPreloading.value = true
    isPreloadReady.value = false
    preloadedBlob.value = null
    preloadedBpm.value = null

    currentPreloadRequestId.value++
    const requestId = currentPreloadRequestId.value
    window.electron.ipcRenderer.send('readNextSongFile', nextSongFilePath, requestId)
  }

  const onReadedNextSongFile = async (
    event: any,
    audioData: Uint8Array,
    filePath: string,
    requestId?: number
  ) => {
    if (!requestId || requestId !== currentPreloadRequestId.value) return
    if (filePath !== preloadedSongFilePath.value) return

    const ab = audioData.buffer.slice(
      audioData.byteOffset,
      audioData.byteOffset + audioData.byteLength
    ) as ArrayBuffer
    const blob = new Blob([ab])
    preloadedBlob.value = blob

    try {
      const arrayBuffer = await blob.arrayBuffer()
      const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer).catch((decodeError) => {
        if (requestId === currentPreloadRequestId.value) {
          handleSongLoadError(filePath)
          clearReadyPreloadState()
        }
        throw decodeError
      })

      const topCandidates = await realtimeBpm.analyzeFullBuffer(decodedBuffer)
      const calculatedBpm = topCandidates[0]?.tempo

      if (requestId === currentPreloadRequestId.value) {
        preloadedBpm.value = calculatedBpm ?? 'N/A'
        isPreloading.value = false
        isPreloadReady.value = true
      } else {
        preloadedBlob.value = null
      }
    } catch (error) {
      if (requestId === currentPreloadRequestId.value) {
        handleSongLoadError(filePath)
        clearReadyPreloadState()
      }
    }
  }

  const onReadNextSongFileError = (
    event: any,
    filePath: string,
    errorMessage: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== currentPreloadRequestId.value) return
    if (filePath === preloadedSongFilePath.value) {
      handleSongLoadError(filePath)
    }
  }

  window.electron.ipcRenderer.on('readedNextSongFile', onReadedNextSongFile)
  window.electron.ipcRenderer.on('readNextSongFileError', onReadNextSongFileError)

  onUnmounted(() => {
    cancelPreloadTimer()
    window.electron.ipcRenderer.removeListener('readedNextSongFile', onReadedNextSongFile)
    window.electron.ipcRenderer.removeListener('readNextSongFileError', onReadNextSongFileError)
  })

  return {
    isPreloading,
    isPreloadReady,
    preloadedBlob,
    preloadedSongFilePath,
    preloadedBpm,
    currentPreloadRequestId,
    cancelPreloadTimer,
    clearReadyPreloadState,
    schedulePreloadAfterPlay,
    preloadNextSong
  }
}
