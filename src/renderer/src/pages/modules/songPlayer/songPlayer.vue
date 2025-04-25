<script setup lang="ts">
import {
  ref,
  onMounted,
  onUnmounted,
  watch,
  useTemplateRef,
  computed,
  readonly,
  toRef,
  shallowRef
} from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIcon from '@renderer/assets/musicIcon.png?asset'
import playerControls from '../../../components/playerControls.vue'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import { t } from '@renderer/utils/translate'
import * as realtimeBpm from 'realtime-bpm-analyzer'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import PlaybackRangeHandles from './PlaybackRangeHandles.vue'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import { usePlayerControlsLogic } from './usePlayerControlsLogic'

const runtime = useRuntimeStore()
const waveform = useTemplateRef<HTMLDivElement>('waveform')
const preloadWaveform = useTemplateRef<HTMLDivElement>('preloadWaveform')

const wavesurferInstance = shallowRef<WaveSurfer | null>(null)
const preloadWavesurferInstance = shallowRef<WaveSurfer | null>(null)
const preloadedBlob = ref<Blob | null>(null)
const preloadedSongFilePath = ref<string | null>(null)
const isPreloading = ref(false)
const isPreloadReady = ref(false)
const isInternalSongChange = ref(false)
let preloadTimerId: any = null
const currentLoadRequestId = ref(0)
const currentPreloadRequestId = ref(0)

let errorDialogShowing = false
const ignoreNextEmptyError = ref(false)

const canvas = document.createElement('canvas')
canvas.height = 50
const ctx = canvas.getContext('2d')

if (ctx === null) {
  throw new Error('ctx is null')
}
const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
gradient.addColorStop(0, '#cccccc')
gradient.addColorStop(1, '#cccccc')

const progressGradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
progressGradient.addColorStop(0, '#0078d4')
progressGradient.addColorStop(1, '#0078d4')
const waveformShow = ref(false)

const waveformContainerWidth = ref(0)

const playerControlsRef = useTemplateRef('playerControlsRef')

const cancelPreloadTimer = () => {
  if (preloadTimerId !== null) {
    clearTimeout(preloadTimerId)
    preloadTimerId = null
  }

  if (isPreloading.value && preloadWavesurferInstance.value) {
    try {
      preloadWavesurferInstance.value.destroy()
      preloadWavesurferInstance.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
    } catch (e) {
      console.error('取消预加载失败:', e)
    }
  }
}

const handleSongLoadError = async (filePath: string | null, isPreload: boolean) => {
  console.error(`Error loading ${isPreload ? 'preload' : 'main'} song: ${filePath}`)

  if (!filePath || errorDialogShowing) {
    return
  }

  if (isPreload) {
    isPreloading.value = false
    isPreloadReady.value = false
    preloadedBlob.value = null
    preloadedSongFilePath.value = null
    return
  }

  errorDialogShowing = true
  const localFilePath = filePath

  try {
    if (wavesurferInstance.value && wavesurferInstance.value.isPlaying()) {
      wavesurferInstance.value.pause()
    }
    waveformShow.value = false
    bpm.value = 'N/A'

    let res = await confirm({
      title: '错误',
      content: [t('该文件无法播放，是否直接删除'), t('（文件内容不是音频或文件已损坏）')]
    })

    if (res === 'confirm') {
      window.electron.ipcRenderer.send('delSongs', [localFilePath], getCurrentTimeDirName())

      const errorIndex = runtime.playingData.playingSongListData.findIndex(
        (item) => item.filePath === localFilePath
      )
      if (errorIndex !== -1) {
        runtime.playingData.playingSongListData.splice(errorIndex, 1)
      }

      if (runtime.playingData.playingSong?.filePath === localFilePath) {
        isInternalSongChange.value = true
        runtime.playingData.playingSong = null
        runtime.playingData.playingSongListUUID = ''
        if (wavesurferInstance.value) wavesurferInstance.value.empty()
      }
    } else {
      if (runtime.playingData.playingSong?.filePath === localFilePath) {
        isInternalSongChange.value = true
        runtime.playingData.playingSong = null
        runtime.playingData.playingSongListUUID = ''
        if (wavesurferInstance.value) wavesurferInstance.value.empty()
        waveformShow.value = false
      }
    }
  } catch (e) {
    console.error('handleSongLoadError 内部发生错误:', e)
  } finally {
    errorDialogShowing = false
  }
}

const createWaveSurferInstance = (container: HTMLDivElement): WaveSurfer => {
  return WaveSurfer.create({
    container: container,
    waveColor: gradient,
    progressColor: progressGradient,
    barWidth: 2,
    autoplay: false,
    height: 40
  })
}

const updateParentWaveformWidth = () => {
  const wrapper = wavesurferInstance.value?.getWrapper()
  if (wrapper) {
    waveformContainerWidth.value = wrapper.clientWidth
  } else {
    waveformContainerWidth.value = 0
  }
}

onMounted(() => {
  if (!waveform.value) {
    console.error('Main waveform container not found!')
    return
  }
  wavesurferInstance.value = createWaveSurferInstance(waveform.value)

  {
    const hover = document.querySelector<HTMLElement>('#hover')
    if (hover === null) {
      throw new Error('hover is null')
    }
    const waveformEl = waveform.value
    if (waveformEl === null) {
      throw new Error('waveform is null')
    }
    waveformEl.addEventListener('pointermove', (e) => (hover.style.width = `${e.offsetX}px`))
  }

  {
    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    const timeEl = document.querySelector('#time')
    if (timeEl === null) {
      throw new Error('timeEl is null')
    }
    const durationEl = document.querySelector('#duration')
    if (durationEl === null) {
      throw new Error('durationEl is null')
    }
    wavesurferInstance.value.on(
      'decode',
      (duration) => (durationEl.textContent = formatTime(duration))
    )

    let previousTime = 0
    const jumpThreshold = 0.5

    wavesurferInstance.value.on('timeupdate', (currentTime) => {
      timeEl.textContent = formatTime(currentTime)
      const deltaTime = currentTime - previousTime

      if (runtime.setting.enablePlaybackRange && wavesurferInstance.value) {
        const duration = wavesurferInstance.value.getDuration()
        const endPercent = runtime.setting.endPlayPercent ?? 100
        const endTime = (duration * endPercent) / 100

        if (
          currentTime >= endTime &&
          previousTime < endTime &&
          wavesurferInstance.value.isPlaying() &&
          deltaTime < jumpThreshold
        ) {
          const currentIndex = runtime.playingData.playingSongListData.findIndex(
            (item) => item.filePath === runtime.playingData.playingSong?.filePath
          )
          const isLastSong =
            currentIndex !== -1 &&
            currentIndex === runtime.playingData.playingSongListData.length - 1

          if (isLastSong) {
            wavesurferInstance.value.pause()
          } else {
            if (runtime.setting.autoPlayNextSong) {
              playerActions.nextSong()
            } else {
              wavesurferInstance.value.pause()
            }
          }
        }
      }
      previousTime = currentTime
    })
    wavesurferInstance.value.on('finish', () => {
      cancelPreloadTimer()
      if (runtime.setting.autoPlayNextSong) {
        playerActions.nextSong()
      }
    })
    wavesurferInstance.value.on('pause', () => {
      cancelPreloadTimer()
      playerControlsRef.value?.setPlayingValue(false)
    })
    wavesurferInstance.value.on('play', () => {
      playerControlsRef.value?.setPlayingValue(true)
      cancelPreloadTimer()
      preloadTimerId = setTimeout(() => {
        preloadNextSong()
        preloadTimerId = null
      }, 3000)
    })

    wavesurferInstance.value.on('error', async (error: any) => {
      const errorCode = error?.code

      if (errorCode === 4 && ignoreNextEmptyError.value) {
        ignoreNextEmptyError.value = false
        return
      }

      console.error('WaveSurfer错误:', error)
      try {
        console.error('错误详情:', error?.originalError || error)
      } catch (e) {
        // 忽略可能的类型错误
      }

      const currentPath = runtime.playingData.playingSong?.filePath ?? null
      console.error(`发生未处理的播放器错误，歌曲路径: ${currentPath}`)

      if (errorCode !== 4) {
        await handleSongLoadError(currentPath, false)
      }
    })
  }
  window.electron.ipcRenderer.on(
    'readedSongFile',
    (event, audioData: Uint8Array, filePath: string, requestId?: number) => {
      if (requestId && requestId !== currentLoadRequestId.value) {
        return
      }

      if (filePath === runtime.playingData.playingSong?.filePath) {
        handleLoadBlob(new Blob([audioData]), filePath, requestId || currentLoadRequestId.value)
      } else {
      }
    }
  )
  window.electron.ipcRenderer.on(
    'readedNextSongFile',
    (event, audioData: Uint8Array, filePath: string, requestId?: number) => {
      if (requestId && requestId !== currentPreloadRequestId.value) {
        return
      }

      if (!preloadWavesurferInstance.value) {
        return
      }

      if (filePath === preloadedSongFilePath.value) {
        try {
          preloadedBlob.value = new Blob([audioData])
          if (
            isPreloading.value &&
            preloadWavesurferInstance.value &&
            filePath === preloadedSongFilePath.value
          ) {
            preloadWavesurferInstance.value.loadBlob(preloadedBlob.value)
          } else {
            preloadedBlob.value = null
          }
        } catch (error) {
          console.error(`预加载音频数据处理错误:`, error)
          handleSongLoadError(filePath, true)
        }
      } else {
      }
    }
  )

  window.electron.ipcRenderer.on(
    'readNextSongFileError',
    (event, filePath: string, errorMessage: string, requestId?: number) => {
      if (requestId && requestId !== currentPreloadRequestId.value) {
        return
      }

      console.error(`预加载歌曲失败: ${filePath}, 错误: ${errorMessage}`)
      if (filePath === preloadedSongFilePath.value) {
        handleSongLoadError(filePath, true)
      }
    }
  )

  window.electron.ipcRenderer.on(
    'readSongFileError',
    (event, filePath: string, errorMessage: string, requestId?: number) => {
      if (requestId && requestId !== currentLoadRequestId.value) {
        return
      }

      console.error(`加载歌曲失败: ${filePath}, 错误: ${errorMessage}`)
      handleSongLoadError(filePath, false)
    }
  )

  if (wavesurferInstance.value) {
    wavesurferInstance.value.on('ready', () => {
      updateParentWaveformWidth()
    })
  }

  window.addEventListener('resize', updateParentWaveformWidth)
})

watch(
  () => runtime.playingData.playingSong,
  (newSong, oldSong) => {
    if (isInternalSongChange.value) {
      isInternalSongChange.value = false
      return
    }

    cancelPreloadTimer()

    if (newSong === null) {
      console.log('[Watch] 切歌: 清空播放器')
      if (wavesurferInstance.value) {
        ignoreNextEmptyError.value = true
        wavesurferInstance.value.empty()
      }
      waveformShow.value = false

      if (preloadWavesurferInstance.value) {
        preloadWavesurferInstance.value.destroy()
        preloadWavesurferInstance.value = null
      }
      runtime.playingData.playingSongListUUID = ''
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      bpm.value = ''
    } else if (newSong?.filePath !== oldSong?.filePath) {
      if (
        newSong.filePath === preloadedSongFilePath.value &&
        isPreloadReady.value &&
        preloadedBlob.value
      ) {
        console.log('[Watch] 切歌: 使用预加载数据 -', newSong.filePath)
        const blobToLoad = preloadedBlob.value

        preloadedBlob.value = null
        preloadedSongFilePath.value = null
        isPreloading.value = false
        isPreloadReady.value = false
        if (preloadWavesurferInstance.value) {
          preloadWavesurferInstance.value.destroy()
          preloadWavesurferInstance.value = null
        }
        handleLoadBlob(blobToLoad, newSong.filePath, currentLoadRequestId.value)
      } else {
        console.log('[Watch] 切歌: 未使用预加载，直接加载 -', newSong.filePath)
        isPreloading.value = false
        isPreloadReady.value = false
        preloadedBlob.value = null
        preloadedSongFilePath.value = null
        if (preloadWavesurferInstance.value) {
          preloadWavesurferInstance.value.destroy()
          preloadWavesurferInstance.value = null
        }
        requestLoadSong(newSong.filePath)
      }
    }
  }
)
onUnmounted(() => {
  cancelPreloadTimer()
  if (wavesurferInstance.value) {
    wavesurferInstance.value.destroy()
    wavesurferInstance.value = null
  }
  if (preloadWavesurferInstance.value) {
    preloadWavesurferInstance.value.destroy()
    preloadWavesurferInstance.value = null
  }
  window.electron.ipcRenderer.removeAllListeners('readedSongFile')
  window.electron.ipcRenderer.removeAllListeners('readedNextSongFile')
  window.electron.ipcRenderer.removeAllListeners('readNextSongFileError')
  window.electron.ipcRenderer.removeAllListeners('readSongFileError')
  window.removeEventListener('resize', updateParentWaveformWidth)
})

const songInfoShow = ref(false)
const coverBlobUrl = ref('')
const audioContext = new AudioContext()
const bpm = ref<number | string>('')

const requestLoadSong = (filePath: string) => {
  cancelPreloadTimer()
  isPreloading.value = false
  isPreloadReady.value = false
  preloadedBlob.value = null
  preloadedSongFilePath.value = null

  if (preloadWavesurferInstance.value) {
    preloadWavesurferInstance.value.destroy()
    preloadWavesurferInstance.value = null
  }

  currentLoadRequestId.value++
  window.electron.ipcRenderer.send('readSongFile', filePath, currentLoadRequestId.value)
}

const handleLoadBlob = async (blob: Blob, filePath: string, requestId: number) => {
  if (requestId !== currentLoadRequestId.value) {
    return
  }

  if (!wavesurferInstance.value || runtime.playingData.playingSong?.filePath !== filePath) {
    return
  }

  if (runtime.playingData.playingSong.cover) {
    if (coverBlobUrl.value) {
      URL.revokeObjectURL(coverBlobUrl.value)
    }
    let coverBlob = new Blob([Uint8Array.from(runtime.playingData.playingSong.cover.data)], {
      type: runtime.playingData.playingSong.cover.format
    })
    coverBlobUrl.value = URL.createObjectURL(coverBlob)
  } else {
    if (coverBlobUrl.value) {
      URL.revokeObjectURL(coverBlobUrl.value)
    }
    coverBlobUrl.value = ''
  }
  waveformShow.value = true
  bpm.value = ''
  try {
    await wavesurferInstance.value.loadBlob(blob)

    if (requestId !== currentLoadRequestId.value) {
      return
    }

    if (runtime.playingData.playingSong?.filePath !== filePath) {
      return
    }

    try {
      if (runtime.setting.enablePlaybackRange && wavesurferInstance.value) {
        const duration = wavesurferInstance.value.getDuration()
        const startPercent = runtime.setting.startPlayPercent ?? 0
        const startTime = (duration * startPercent) / 100
        wavesurferInstance.value.play(startTime)
      } else {
        wavesurferInstance.value?.play()
      }
    } catch (playError: any) {
      if (playError.name === 'AbortError') {
        console.info('播放被中断，可能是因为快速切换歌曲')
      } else {
        throw playError
      }
    }

    try {
      blob
        .arrayBuffer()
        .then(async (arrayBuffer) => {
          try {
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
            realtimeBpm.analyzeFullBuffer(audioBuffer).then((topCandidates) => {
              if (runtime.playingData.playingSong?.filePath === filePath) {
                bpm.value = topCandidates[0].tempo
              }
            })
          } catch (decodeError) {
            console.error('Error decoding audio data for BPM:', decodeError)
            if (runtime.playingData.playingSong?.filePath === filePath) {
              bpm.value = 'N/A'
            }
          }
        })
        .catch((bufferError) => {
          console.error('Error getting array buffer from blob for BPM:', bufferError)
          if (runtime.playingData.playingSong?.filePath === filePath) {
            bpm.value = 'N/A'
          }
        })
    } catch (e) {
      console.error('Error initiating BPM analysis:', e)
      if (runtime.playingData.playingSong?.filePath === filePath) {
        bpm.value = 'N/A'
      }
    }
  } catch (loadError) {
    console.error(`Error loading blob or starting playback for ${filePath}:`, loadError)
    if ((loadError as any)?.name !== 'AbortError') {
      await handleSongLoadError(filePath, false)
    }
  }
}

const preloadNextSong = () => {
  if (isPreloading.value || !runtime.playingData.playingSong || !preloadWaveform.value) return

  const currentIndex = runtime.playingData.playingSongListData.findIndex(
    (item) => item.filePath === runtime.playingData.playingSong?.filePath
  )
  if (currentIndex === -1 || currentIndex >= runtime.playingData.playingSongListData.length - 1) {
    return
  }
  const nextSongToPreload = runtime.playingData.playingSongListData[currentIndex + 1]
  if (!nextSongToPreload?.filePath) {
    return
  }
  const nextSongFilePath = nextSongToPreload.filePath

  if (
    nextSongFilePath === preloadedSongFilePath.value &&
    (isPreloadReady.value || isPreloading.value)
  ) {
    return
  }

  if (preloadWavesurferInstance.value) {
    try {
      preloadWavesurferInstance.value.destroy()
    } catch (e) {
      console.error('Error destroying previous preload instance:', e)
    }
    preloadWavesurferInstance.value = null
  }

  if (!preloadWaveform.value) {
    return
  }
  try {
    preloadWavesurferInstance.value = createWaveSurferInstance(preloadWaveform.value)

    preloadedSongFilePath.value = nextSongFilePath
    isPreloading.value = true
    isPreloadReady.value = false
    preloadedBlob.value = null

    currentPreloadRequestId.value++
    const requestId = currentPreloadRequestId.value

    preloadWavesurferInstance.value.on('ready', () => {
      if (preloadedSongFilePath.value === nextSongFilePath && preloadWavesurferInstance.value) {
        isPreloading.value = false
        isPreloadReady.value = true
      } else {
        console.log('预加载 ready 事件触发时状态已变更')
        isPreloading.value = false
        isPreloadReady.value = false
        preloadedSongFilePath.value = null
        preloadedBlob.value = null
        preloadWavesurferInstance.value?.destroy()
        preloadWavesurferInstance.value = null
      }
    })
    preloadWavesurferInstance.value.on('error', (error) => {
      console.error('预加载Wavesurfer错误:', error, preloadedSongFilePath.value)
      if (
        preloadedSongFilePath.value === nextSongFilePath &&
        requestId === currentPreloadRequestId.value
      ) {
        handleSongLoadError(preloadedSongFilePath.value, true)
      }
    })

    window.electron.ipcRenderer.send('readNextSongFile', nextSongFilePath, requestId)
  } catch (createError) {
    console.error('Error creating preload wavesurfer instance:', createError)
    preloadWavesurferInstance.value = null
    isPreloading.value = false
    preloadedSongFilePath.value = null
    return
  }
}

const selectSongListDialogLibraryName = ref('筛选库')
const selectSongListDialogShow = ref(false)

const playerActions = usePlayerControlsLogic({
  wavesurferInstance,
  preloadWavesurferInstance,
  runtime,
  bpm,
  waveformShow,
  selectSongListDialogShow,
  selectSongListDialogLibraryName,
  isInternalSongChange,
  requestLoadSong,
  handleLoadBlob,
  cancelPreloadTimer,
  currentLoadRequestId,
  preloadedBlob,
  preloadedSongFilePath,
  isPreloading,
  isPreloadReady,
  ignoreNextEmptyError
})

const selectSongListDialogConfirm = async (item: string) => {
  await playerActions.handleMoveSong(item)
}

const bpmDomRef = useTemplateRef('bpmDomRef')

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const hotkeyActions = {
  play: playerActions.play,
  pause: playerActions.pause,
  fastForward: playerActions.fastForward,
  fastBackward: playerActions.fastBackward,
  nextSong: playerActions.nextSong,
  previousSong: playerActions.previousSong,
  delSong: playerActions.delSong,
  moveToListLibrary: playerActions.moveToListLibrary,
  moveToLikeLibrary: playerActions.moveToLikeLibrary,
  togglePlayPause: playerActions.togglePlayPause
}

const isPlaying = computed(() => wavesurferInstance.value?.isPlaying() ?? false)

const playerState = {
  waveformShow,
  selectSongListDialogShow,
  confirmShow: readonly(toRef(runtime, 'confirmShow')),
  songsAreaSelectedCount: computed(() => runtime.songsArea.selectedSongFilePath.length),
  activeMenuUUID: toRef(runtime, 'activeMenuUUID'),
  isPlaying: readonly(isPlaying)
}

usePlayerHotkeys(hotkeyActions, playerState, runtime)
</script>
<template>
  <div
    style="
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      padding: 0 5px 0 0;
      box-sizing: border-box;
    "
  >
    <div style="width: 50px; display: flex" class="unselectable">
      <div
        v-show="waveformShow"
        style="
          display: flex;
          justify-content: center;
          align-items: center;
          height: 50px;
          width: 50px;
        "
        @mouseenter="songInfoShow = true"
      >
        <img v-if="coverBlobUrl" :src="coverBlobUrl" class="songCover" />
        <img v-else :src="musicIcon" style="width: 25px; height: 25px" />
      </div>
    </div>
    <transition name="fade">
      <div v-if="songInfoShow" @mouseleave="songInfoShow = false" class="songInfo">
        <div class="cover unselectable">
          <img
            v-if="coverBlobUrl"
            :src="coverBlobUrl"
            style="width: 280px; height: 280px"
            draggable="false"
          />
          <img v-else :src="musicIcon" style="width: 48px; height: 48px" draggable="false" />
        </div>
        <div style="font-size: 14px" class="info">
          {{ runtime.playingData.playingSong?.title }}
        </div>
        <div style="font-size: 12px" class="info">
          {{ runtime.playingData.playingSong?.artist }}
        </div>
        <div style="font-size: 10px" class="info">
          {{ runtime.playingData.playingSong?.album }}
        </div>
        <div style="font-size: 10px" class="info">
          {{ runtime.playingData.playingSong?.label }}
        </div>
      </div>
    </transition>
    <div
      :style="{ width: runtime.setting.hiddenPlayControlArea ? '15px' : '260px' }"
      v-show="waveformShow"
    >
      <playerControls
        v-if="!runtime.setting.hiddenPlayControlArea"
        ref="playerControlsRef"
        @pause="playerActions.pause"
        @play="playerActions.play"
        @fastForward="playerActions.fastForward"
        @fastBackward="playerActions.fastBackward"
        @nextSong="playerActions.nextSong"
        @previousSong="playerActions.previousSong"
        @delSong="playerActions.delSong"
        @moveToListLibrary="playerActions.moveToListLibrary"
        @moveToLikeLibrary="playerActions.moveToLikeLibrary"
        @exportTrack="playerActions.exportTrack"
      />
    </div>

    <div style="flex-grow: 1; position: relative" class="unselectable">
      <div id="waveform" ref="waveform" v-show="waveformShow">
        <div id="time">0:00</div>
        <div id="duration">0:00</div>
        <div id="hover"></div>
      </div>
      <div id="preload-waveform" ref="preloadWaveform" style="display: none"></div>

      <PlaybackRangeHandles
        v-model:modelValueStart="runtime.setting.startPlayPercent"
        v-model:modelValueEnd="runtime.setting.endPlayPercent"
        :container-width="waveformContainerWidth"
        :enable-playback-range="runtime.setting.enablePlaybackRange"
        :waveform-show="waveformShow"
        @dragEnd="setSetting"
      />
    </div>
    <div
      class="unselectable"
      ref="bpmDomRef"
      style="
        width: 50px;
        display: flex;
        justify-content: center;
        align-items: center;
        font-size: 16px;
        font-weight: bold;
      "
      v-show="waveformShow"
    >
      {{ bpm }}
    </div>
    <bubbleBox :dom="bpmDomRef || undefined" title="BPM" :right="1" :width="60" />
  </div>
  <selectSongListDialog
    v-if="selectSongListDialogShow"
    :libraryName="selectSongListDialogLibraryName"
    @confirm="selectSongListDialogConfirm"
    @cancel="
      () => {
        selectSongListDialogShow = false
      }
    "
  />
</template>
<style lang="scss" scoped>
.songInfo {
  width: 300px;
  height: 370px;
  background-color: #202020;
  position: absolute;
  bottom: 25px;
  left: 50px;
  border: 1px solid #424242;
  border-radius: 3px;
  padding-top: 10px;
  z-index: 99;

  .cover {
    width: 100%;
    height: 280px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .info {
    width: 100%;
    padding: 5px 10px 0;
    box-sizing: border-box;
    white-space: nowrap;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}

#waveform {
  cursor: pointer;
  position: relative;
  min-height: 40px;
}

.songCover {
  width: 40px;
  height: 40px;
}

#hover {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 10;
  pointer-events: none;
  height: 100%;
  width: 0;
  mix-blend-mode: overlay;
  background: rgba(255, 255, 255, 0.5);
  opacity: 0;
  transition: opacity 0.2s ease;
}

#waveform:hover #hover {
  opacity: 1;
}

#time,
#duration {
  position: absolute;
  z-index: 11;
  top: 50%;
  margin-top: -1px;
  transform: translateY(-50%);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.75);
  padding: 2px;
  color: #ddd;
}

#time {
  left: 0;
}

#duration {
  right: 0;
}
</style>
