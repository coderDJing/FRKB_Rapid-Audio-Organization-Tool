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
  shallowRef,
  nextTick
} from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIcon from '@renderer/assets/musicIcon.png?asset'
import playerControls from '../../../components/playerControls.vue'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import { t } from '@renderer/utils/translate'
import * as realtimeBpm from 'realtime-bpm-analyzer'
import BpmTap from './BpmTap.vue'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import PlaybackRangeHandles from './PlaybackRangeHandles.vue'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import { usePlayerControlsLogic } from './usePlayerControlsLogic'
import rightClickMenu from '@renderer/components/rightClickMenu'
import emitter from '@renderer/utils/mitt'

const runtime = useRuntimeStore()
const waveform = useTemplateRef<HTMLDivElement>('waveform')

const wavesurferInstance = shallowRef<WaveSurfer | null>(null)
const preloadedBlob = ref<Blob | null>(null)
const preloadedSongFilePath = ref<string | null>(null)
const preloadedBpm = ref<number | string | null>(null)
const isPreloading = ref(false)
const isPreloadReady = ref(false)
const isInternalSongChange = ref(false)
let preloadTimerId: any = null
const currentLoadRequestId = ref(0)
const currentPreloadRequestId = ref(0)

const isLoadingBlob = ref(false) // Flag to prevent re-entrancy

let errorDialogShowing = false
const ignoreNextEmptyError = ref(false)

// 调试日志已清理

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
      title: t('common.error'),
      content: [t('tracks.cannotPlay'), t('tracks.cannotPlayHint')]
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

      // 广播删除，确保当前 songsArea 若正显示该列表可同步移除数据，避免后续“复活”
      emitter.emit('songsRemoved', {
        listUUID: runtime.playingData.playingSongListUUID,
        paths: [localFilePath]
      })
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
  const waveformEl = waveform.value
  if (waveformEl && waveformShow.value && waveformEl.offsetParent !== null) {
    waveformContainerWidth.value = waveformEl.clientWidth
  } else {
    waveformContainerWidth.value = 0
  }
}

const attachEventListeners = (targetInstance: WaveSurfer) => {
  if (!targetInstance) return

  const timeEl = document.querySelector('#time')
  const durationEl = document.querySelector('#duration')

  if (!timeEl || !durationEl) {
    console.error('Time/Duration elements not found during listener attachment!')
    return
  }

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    const secondsRemainder = Math.round(seconds) % 60
    const paddedSeconds = `0${secondsRemainder}`.slice(-2)
    return `${minutes}:${paddedSeconds}`
  }

  targetInstance.on('decode', (duration) => {
    if (durationEl) durationEl.textContent = formatTime(duration)
    updateParentWaveformWidth()
  })

  // 用于跟踪上一次的时间，避免手动 seek 触发区间结束逻辑
  let previousTime = 0
  const jumpThreshold = 0.5 // 时间跳跃阈值（秒）

  targetInstance.on('timeupdate', (currentTime) => {
    if (!(targetInstance as any).__hasLoggedTimeUpdate) {
      ;(targetInstance as any).__hasLoggedTimeUpdate = true
    }
    timeEl.textContent = formatTime(currentTime)

    // --- 添加处理播放范围结束逻辑 ---
    const deltaTime = currentTime - previousTime
    if (
      runtime.setting.enablePlaybackRange &&
      targetInstance === wavesurferInstance.value // 只对主实例生效
    ) {
      const duration = targetInstance.getDuration()
      if (duration > 0) {
        // 确保 duration > 0 避免 NaN
        const endPercent = runtime.setting.endPlayPercent ?? 100
        const endTime = (duration * endPercent) / 100

        // 检查是否自然播放到达或超过了结束点，并且不是因为 seek 导致的
        if (
          currentTime >= endTime &&
          previousTime < endTime && // 确保是从结束点之前过来的
          targetInstance.isPlaying() &&
          deltaTime < jumpThreshold // 确保不是大的时间跳跃 (seek)
        ) {
          if (runtime.setting.autoPlayNextSong) {
            playerActions.nextSong() // 使用 playerActions
          } else {
            targetInstance.pause()
          }
        }
      }
    }
    previousTime = currentTime // 更新上一次的时间
    // --- 结束添加的逻辑 ---
  })

  targetInstance.on('finish', () => {
    cancelPreloadTimer()
    if (runtime.setting.autoPlayNextSong) {
      playerActions.nextSong()
    }
  })

  targetInstance.on('pause', () => {
    cancelPreloadTimer()
    playerControlsRef.value?.setPlayingValue(false)
  })

  targetInstance.on('play', () => {
    playerControlsRef.value?.setPlayingValue(true)
    cancelPreloadTimer()

    preloadTimerId = setTimeout(() => {
      const timerId = preloadTimerId
      preloadNextSong()
      if (preloadTimerId === timerId) {
        preloadTimerId = null
      }
    }, 3000)

    // 真正开始播放后才认为播放器就绪
    runtime.playerReady = true
    runtime.isSwitchingSong = false
  })

  targetInstance.on('ready', () => {
    updateParentWaveformWidth()
    // ready 触发较早，延迟到真正开始播放后再标记就绪
  })

  targetInstance.on('error', async (error: any) => {
    const errorCode = error?.code

    if (errorCode === 4 && ignoreNextEmptyError.value) {
      ignoreNextEmptyError.value = false
      return
    }

    console.error('WaveSurfer错误:', error)
    try {
      console.error('错误详情:', error?.originalError || error)
    } catch (e) {
      /* ignore */
    }

    const currentPath = runtime.playingData.playingSong?.filePath ?? 'N/A'
    console.error(`发生未处理的播放器错误，歌曲路径: ${currentPath}`)

    if (errorCode !== 4) {
      await handleSongLoadError(currentPath, false)
    }
  })
}

const detachEventListeners = (targetInstance: WaveSurfer) => {
  if (!targetInstance) return
  targetInstance.unAll()

  if ((targetInstance as any).__hasLoggedTimeUpdate) {
    delete (targetInstance as any).__hasLoggedTimeUpdate
  }

  if (waveform.value && (targetInstance as any).__pointerMoveHandler) {
    waveform.value.removeEventListener('pointermove', (targetInstance as any).__pointerMoveHandler)
    delete (targetInstance as any).__pointerMoveHandler
  }
}

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const secondsRemainder = Math.round(seconds) % 60
  const paddedSeconds = `0${secondsRemainder}`.slice(-2)
  return `${minutes}:${paddedSeconds}`
}

onMounted(() => {
  if (!waveform.value) {
    console.error('Main waveform container not found!')
    return
  }
  wavesurferInstance.value = createWaveSurferInstance(waveform.value)

  attachEventListeners(wavesurferInstance.value)

  window.electron.ipcRenderer.on(
    'readedSongFile',
    (event, audioData: Uint8Array, filePath: string, requestId?: number) => {
      if (requestId && requestId !== currentLoadRequestId.value) {
        const name = (filePath?.match(/[^\\/]+$/) || [])[0] || 'unknown'
        return
      }

      // 验证此时UI显示的歌曲与返回的文件路径是否匹配
      if (filePath === runtime.playingData.playingSong?.filePath) {
        const name = (filePath?.match(/[^\\/]+$/) || [])[0] || 'unknown'
        handleLoadBlob(new Blob([audioData]), filePath, requestId || currentLoadRequestId.value)
      } else {
        const name = (filePath?.match(/[^\\/]+$/) || [])[0] || 'unknown'
        const cur = runtime.playingData.playingSong?.filePath || 'N/A'
        const curName = (cur.match(/[^\\/]+$/) || [])[0] || cur
      }
    }
  )
  window.electron.ipcRenderer.on(
    'readedNextSongFile',
    async (event, audioData: Uint8Array, filePath: string, requestId?: number) => {
      if (!requestId || requestId !== currentPreloadRequestId.value) {
        return
      }

      if (filePath !== preloadedSongFilePath.value) {
        return
      }

      const blob = new Blob([audioData])
      preloadedBlob.value = blob

      try {
        const arrayBuffer = await blob.arrayBuffer()

        const decodedBuffer = await audioContext
          .decodeAudioData(arrayBuffer)
          .catch((decodeError) => {
            console.error(
              `[IPC readedNextSongFile] Audio decode failed for path: ${filePath}`,
              decodeError
            )
            if (requestId === currentPreloadRequestId.value) {
              handleSongLoadError(filePath, true)
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
          const name = (filePath?.match(/[^\\/]+$/) || [])[0] || 'unknown'
        } else {
          preloadedBlob.value = null
        }
      } catch (error) {
        console.error(
          `[IPC readedNextSongFile] Error during async processing for ${filePath}:`,
          error
        )
        if (requestId === currentPreloadRequestId.value) {
          handleSongLoadError(filePath, true)
          clearReadyPreloadState()
        }
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
        const name = (filePath?.match(/[^\\/]+$/) || [])[0] || 'unknown'
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
      const name = (filePath?.match(/[^\\/]+$/) || [])[0] || 'unknown'
      handleSongLoadError(filePath, false)
    }
  )

  if (wavesurferInstance.value) {
    wavesurferInstance.value.on('ready', () => {
      updateParentWaveformWidth()
      // 不在 ready 时置为就绪，避免过早放开快进
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

    if (newSong === null) {
      cancelPreloadTimer()
      clearReadyPreloadState()
      if (wavesurferInstance.value) {
        ignoreNextEmptyError.value = true // 设置标志来忽略空src错误
        wavesurferInstance.value.empty()
      }
      waveformShow.value = false
      runtime.playingData.playingSongListUUID = ''
      bpm.value = ''
    } else if (newSong?.filePath !== oldSong?.filePath) {
      const newPath = newSong.filePath
      if (isPreloadReady.value && newPath === preloadedSongFilePath.value && preloadedBlob.value) {
        // 命中预加载，使用预加载的数据和BPM
        const blobToLoad = preloadedBlob.value
        const bpmValueToUse = preloadedBpm.value

        // 清理预加载状态
        clearReadyPreloadState()

        // 使用当前实例加载预加载的数据
        currentLoadRequestId.value++
        handleLoadBlob(blobToLoad, newPath, currentLoadRequestId.value, bpmValueToUse)
      } else {
        // 未命中预加载，请求加载歌曲
        cancelPreloadTimer()
        clearReadyPreloadState()
        requestLoadSong(newPath)
      }
    }
  }
)

onUnmounted(() => {
  cancelPreloadTimer()
  if (wavesurferInstance.value) {
    detachEventListeners(wavesurferInstance.value)
    wavesurferInstance.value.destroy()
    wavesurferInstance.value = null
  }
  runtime.playerReady = false
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

  // 重置加载状态标志，使后续加载请求可以被处理
  isLoadingBlob.value = false

  // 每次切换歌曲时，强制清空wavesurfer实例，确保不受先前加载的影响
  if (wavesurferInstance.value) {
    // 先暂停播放
    if (wavesurferInstance.value.isPlaying()) {
      wavesurferInstance.value.pause()
    }

    // 设置标志忽略empty触发的错误
    ignoreNextEmptyError.value = true

    // 清空实例，强制重置内部状态
    wavesurferInstance.value.empty()
  }

  // 新的歌曲开始加载前，标记播放器未就绪，防止快进触发
  runtime.playerReady = false

  // 增加一个控制台日志以帮助调试
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
  // 立即检查请求ID是否匹配当前最新ID
  if (requestId !== currentLoadRequestId.value) {
    return
  }

  // 防止重入
  if (isLoadingBlob.value) {
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

    // 再次检查是否仍然是当前需要的请求
    if (requestId !== currentLoadRequestId.value) {
      isLoadingBlob.value = false
      return
    }

    // 检查文件路径是否仍然匹配
    if (runtime.playingData.playingSong?.filePath !== filePath) {
      isLoadingBlob.value = false
      return
    }

    if (bpmValueAssigned) {
    } else {
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
            realtimeBpm.analyzeFullBuffer(audioBuffer).then((topCandidates) => {
              if (
                requestId === currentLoadRequestId.value &&
                runtime.playingData.playingSong?.filePath === filePath
              ) {
                bpm.value = topCandidates[0]?.tempo ?? 'N/A'
              }
            })
          } catch (decodeError) {
            console.error('[handleLoadBlob] Error decoding audio data for BPM:', decodeError)
            if (
              requestId === currentLoadRequestId.value &&
              runtime.playingData.playingSong?.filePath === filePath
            ) {
              bpm.value = 'N/A'
            }
          }
        })
        .catch((bufferError) => {
          console.error(
            '[handleLoadBlob] Error getting array buffer from blob for BPM:',
            bufferError
          )
          if (
            requestId === currentLoadRequestId.value &&
            runtime.playingData.playingSong?.filePath === filePath
          ) {
            bpm.value = 'N/A'
          }
        })
    }

    try {
      // 记录即将播放的文件信息，用于最终确认
      const fileToPlay = filePath
      const reqIdToPlay = requestId

      // 最终确认这是最新请求
      if (reqIdToPlay !== currentLoadRequestId.value) {
        return
      }

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
        console.error(`[handleLoadBlob] 播放错误:`, playError)
        throw playError
      }
    }
  } catch (loadError) {
    console.error(`Error loading blob or starting playback for ${filePath}:`, loadError)

    // 如果是NotSupportedError错误，这可能是因为wavesurfer实例被清空了
    if ((loadError as any)?.name === 'NotSupportedError') {
      // 检查ID是否仍然匹配
      if (requestId !== currentLoadRequestId.value) {
        // 请求已过期，忽略错误
      } else {
        // 如果ID仍然匹配，则不做进一步处理
        // 这里不直接调用requestLoadSong，避免递归
      }
    } else if ((loadError as any)?.name !== 'AbortError') {
      // 其他非中止错误
      await handleSongLoadError(filePath, false)
    }
  } finally {
    // 无论成功失败都确保重置加载状态
    isLoadingBlob.value = false
  }
}

const preloadNextSong = () => {
  if (isPreloading.value || !runtime.playingData.playingSong) {
    return
  }

  const currentIndex = runtime.playingData.playingSongListData.findIndex(
    (item) => item.filePath === runtime.playingData.playingSong?.filePath
  )
  if (currentIndex === -1 || currentIndex >= runtime.playingData.playingSongListData.length - 1) {
    return
  }
  const nextSongToPreload = runtime.playingData.playingSongListData[currentIndex + 1]
  if (!nextSongToPreload?.filePath) {
    console.error('[Preload] Error: Next song data found but file path is missing.')
    return
  }
  const nextSongFilePath = nextSongToPreload.filePath

  if (nextSongFilePath === preloadedSongFilePath.value && isPreloadReady.value) {
    return
  }

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

const selectSongListDialogLibraryName = ref('FilterLibrary')
const selectSongListDialogShow = ref(false)

// 控制是否显示右键菜单，用于禁用封面弹窗的mouseleave
const isShowingContextMenu = ref(false)

// 保存右键时的封面快照，避免歌曲切换时下载错误的封面
const contextMenuCoverSnapshot = ref<{
  blobUrl: string
  songTitle: string
  artist: string
  format: string
} | null>(null)

// 处理封面弹窗的鼠标离开事件
const handleSongInfoMouseLeave = () => {
  // 如果正在显示右键菜单，则不关闭弹窗
  if (isShowingContextMenu.value) {
    return
  }
  songInfoShow.value = false
}

// 右键菜单相关
const showCoverContextMenu = async (event: MouseEvent) => {
  // 只在有封面时显示菜单
  if (!runtime.playingData.playingSong?.cover || !coverBlobUrl.value) {
    return
  }

  // 使用 setTimeout 让菜单在下一个事件循环中创建
  // 这样全局的 contextmenu 处理器会先执行（清空旧菜单），然后再创建新菜单
  setTimeout(async () => {
    isShowingContextMenu.value = true

    // 保存当前封面的快照，避免菜单显示期间歌曲切换导致下载错误的封面
    const currentSong = runtime.playingData.playingSong
    if (currentSong?.cover && coverBlobUrl.value) {
      contextMenuCoverSnapshot.value = {
        blobUrl: coverBlobUrl.value,
        songTitle: currentSong.title || t('tracks.unknownTrack'),
        artist: currentSong.artist || t('tracks.unknownArtist'),
        format: currentSong.cover.format || 'image/jpeg'
      }
    }

    const menuArr = [
      [
        {
          menuName: 'tracks.saveCoverAs',
          shortcutKey: ''
        }
      ]
    ]

    const result = await rightClickMenu({ menuArr, clickEvent: event })

    isShowingContextMenu.value = false

    if (result !== 'cancel' && result.menuName === 'tracks.saveCoverAs') {
      saveCoverAs()
    }

    // 清理快照
    contextMenuCoverSnapshot.value = null
  }, 0)
}

const saveCoverAs = () => {
  // 使用保存的快照数据，而不是当前的数据
  if (!contextMenuCoverSnapshot.value) {
    return
  }

  const snapshot = contextMenuCoverSnapshot.value

  // 根据格式确定文件扩展名
  let extension = 'jpg'
  if (snapshot.format) {
    if (snapshot.format.includes('png')) {
      extension = 'png'
    } else if (snapshot.format.includes('jpeg') || snapshot.format.includes('jpg')) {
      extension = 'jpg'
    }
  }

  const suggestedName = `${snapshot.artist} - ${snapshot.songTitle}.${extension}`

  // 创建临时的下载链接
  const link = document.createElement('a')
  link.href = snapshot.blobUrl
  link.download = suggestedName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

const playerActions = usePlayerControlsLogic({
  wavesurferInstance,
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
  preloadedBpm,
  isPreloading,
  isPreloadReady,
  ignoreNextEmptyError,
  clearReadyPreloadState
})

const selectSongListDialogConfirm = async (item: string) => {
  await playerActions.handleMoveSong(item)
}

// 移除旧的 bpmDomRef（由 BpmTap 组件内部管理）

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

watch(
  () => runtime.setting.hiddenPlayControlArea,
  async (newValue, oldValue) => {
    if (newValue !== oldValue && waveformShow.value && wavesurferInstance.value) {
      await nextTick()
      updateParentWaveformWidth()
    }
  }
)
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
      <div v-if="songInfoShow" @mouseleave="handleSongInfoMouseLeave" class="songInfo">
        <div class="cover unselectable" @contextmenu.prevent="showCoverContextMenu">
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
        @moveToListLibrary="(song) => playerActions.moveToListLibrary(song)"
        @moveToLikeLibrary="(song) => playerActions.moveToLikeLibrary(song)"
        @exportTrack="playerActions.exportTrack"
      />
    </div>

    <div style="flex-grow: 1; position: relative" class="unselectable">
      <div id="waveform" ref="waveform" v-show="waveformShow">
        <div id="time">0:00</div>
        <div id="duration">0:00</div>
        <div id="hover"></div>
      </div>

      <PlaybackRangeHandles
        v-model:modelValueStart="runtime.setting.startPlayPercent"
        v-model:modelValueEnd="runtime.setting.endPlayPercent"
        :container-width="waveformContainerWidth"
        :enable-playback-range="runtime.setting.enablePlaybackRange"
        :waveform-show="waveformShow"
        @dragEnd="setSetting"
      />
    </div>
    <BpmTap :bpm="bpm" :waveformShow="waveformShow" />
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
