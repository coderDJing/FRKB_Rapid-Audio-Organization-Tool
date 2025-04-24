<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick, useTemplateRef } from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import musicIcon from '@renderer/assets/musicIcon.png?asset'
import playerControls from '../../components/playerControls.vue'
import hotkeys from 'hotkeys-js'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import exportDialog from '@renderer/components/exportDialog'
import { t } from '@renderer/utils/translate'
import * as realtimeBpm from 'realtime-bpm-analyzer'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { getCurrentTimeDirName } from '@renderer/utils/utils'

const runtime = useRuntimeStore()
const waveform = useTemplateRef<HTMLDivElement>('waveform')
const preloadWaveform = useTemplateRef<HTMLDivElement>('preloadWaveform')

let wavesurferInstance: WaveSurfer | null = null
let preloadWavesurferInstance: WaveSurfer | null = null
let preloadedBlob: Blob | null = null
let preloadedSongFilePath: string | null = null
let isPreloading = false
let isPreloadReady = false
let isInternalSongChange = ref(false)
let preloadTimerId: any = null
let currentLoadRequestId = 0
let currentPreloadRequestId = 0

// 添加一个标志来管理正在进行的文件操作和错误处理状态
let isFileOperationInProgress = false
let errorDialogShowing = false
let pendingFileOperation: null | {
  type: 'delete' | 'move'
  filePath: string
  data: any
} = null

// 新增：用于精确忽略 empty() 调用的错误
let ignoreNextEmptyError = false

const canvas = document.createElement('canvas')
canvas.height = 50
const ctx = canvas.getContext('2d')

// Define the waveform gradient
if (ctx === null) {
  throw new Error('ctx is null')
}
const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
gradient.addColorStop(0, '#cccccc') // Top color
gradient.addColorStop(1, '#cccccc') // Bottom color

const progressGradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
progressGradient.addColorStop(0, '#0078d4') // Top color
progressGradient.addColorStop(1, '#0078d4') // Bottom color
const waveformShow = ref(false)

const playerControlsRef = useTemplateRef('playerControlsRef')

// 修改 cancelPreloadTimer 以更全面地重置预加载状态
const cancelPreloadTimer = () => {
  if (preloadTimerId !== null) {
    clearTimeout(preloadTimerId)
    preloadTimerId = null
  }

  // 检查是否在进行预加载，如果是，则取消
  if (isPreloading && preloadWavesurferInstance) {
    try {
      // 使用正确的API取消预加载
      preloadWavesurferInstance.destroy()
      preloadWavesurferInstance = null
      isPreloading = false
      isPreloadReady = false
      preloadedBlob = null
      preloadedSongFilePath = null
    } catch (e) {
      console.error('取消预加载失败:', e) // 保留 Error
    }
  }
}

// 修改 handleSongLoadError，只处理意外错误，不进行列表操作
const handleSongLoadError = async (filePath: string | null, isPreload: boolean) => {
  console.error(`Error loading ${isPreload ? 'preload' : 'main'} song: ${filePath}`) // 保留 Error

  // 跳过空文件路径、正在进行文件操作或已有错误对话框的情况
  if (!filePath || isFileOperationInProgress || errorDialogShowing) {
    return
  }

  // 预加载错误只记录不处理
  if (isPreload) {
    isPreloading = false
    isPreloadReady = false
    preloadedBlob = null
    preloadedSongFilePath = null
    return
  }

  // 防止重复触发
  errorDialogShowing = true
  const localFilePath = filePath // 保存当前处理的文件路径副本

  try {
    // 尝试暂停播放，但不清空，避免触发 media error 4
    if (wavesurferInstance && wavesurferInstance.isPlaying()) {
      wavesurferInstance.pause()
    }
    waveformShow.value = false // 隐藏波形图
    bpm.value = 'N/A'

    // 显示错误对话框
    let res = await confirm({
      title: '错误',
      content: [t('该文件无法播放，是否直接删除'), t('（文件内容不是音频或文件已损坏）')]
    })

    // 如果用户确认删除
    if (res === 'confirm') {
      // 注意：这里只发送删除命令，不修改当前列表状态
      // 列表状态由 delSong 或 selectSongListDialogConfirm 管理
      // 或者需要一个独立的机制来处理这里的删除对列表的影响
      // 为避免复杂性，暂时只发送删除命令
      window.electron.ipcRenderer.send('delSongs', [localFilePath], getCurrentTimeDirName())

      // 从当前播放列表中找到并移除（如果存在）
      // 这一步是为了防止错误处理后，文件已被删除但列表未更新
      const errorIndex = runtime.playingData.playingSongListData.findIndex(
        (item) => item.filePath === localFilePath
      )
      if (errorIndex !== -1) {
        runtime.playingData.playingSongListData.splice(errorIndex, 1)
      }

      // 如果删除的是当前正在尝试播放的歌曲，则清空播放状态
      if (runtime.playingData.playingSong?.filePath === localFilePath) {
        isInternalSongChange.value = true
        runtime.playingData.playingSong = null
        runtime.playingData.playingSongListUUID = ''
        if (wavesurferInstance) wavesurferInstance.empty() // 清空播放器
      }
    } else {
      // 如果用户取消，并且错误发生在当前歌曲上，也需要清空状态
      if (runtime.playingData.playingSong?.filePath === localFilePath) {
        isInternalSongChange.value = true
        runtime.playingData.playingSong = null
        runtime.playingData.playingSongListUUID = ''
        if (wavesurferInstance) wavesurferInstance.empty() // 清空播放器
        waveformShow.value = false // 确保波形图隐藏
      }
    }
  } catch (e) {
    console.error('handleSongLoadError 内部发生错误:', e) // 保留 Error
  } finally {
    // 重置错误对话框显示标志
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

onMounted(() => {
  if (!waveform.value) {
    console.error('Main waveform container not found!') // 保留 Error
    return
  }
  wavesurferInstance = createWaveSurferInstance(waveform.value)

  // --- 主实例事件监听 ---
  // Hover effect
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

  // Current time & duration
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
    wavesurferInstance.on('decode', (duration) => (durationEl.textContent = formatTime(duration)))

    let previousTime = 0 // 用于跟踪上一次的时间
    const jumpThreshold = 0.5 // 定义时间跳跃的阈值（秒）

    wavesurferInstance.on('timeupdate', (currentTime) => {
      // 更新时间显示
      timeEl.textContent = formatTime(currentTime)
      const deltaTime = currentTime - previousTime

      // 处理播放范围结束逻辑
      if (runtime.setting.enablePlaybackRange && wavesurferInstance) {
        const duration = wavesurferInstance.getDuration()
        // 确保 endPlayPercent 有值，默认为 100
        const endPercent = runtime.setting.endPlayPercent ?? 100
        const endTime = (duration * endPercent) / 100

        // 检查是否自然播放到达或超过了结束点（通过 deltaTime 判断是否为大跳跃）
        if (
          currentTime >= endTime &&
          previousTime < endTime &&
          wavesurferInstance.isPlaying() &&
          deltaTime < jumpThreshold
        ) {
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          if (runtime.setting.autoPlayNextSong) {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            nextSong()
          } else {
            wavesurferInstance.pause()
          }
        }
      }
      // 更新 previousTime
      previousTime = currentTime
    })
    wavesurferInstance.on('finish', () => {
      cancelPreloadTimer()
      if (runtime.setting.autoPlayNextSong) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        nextSong()
      }
    })
    wavesurferInstance.on('pause', () => {
      cancelPreloadTimer()
      playerControlsRef.value?.setPlayingValue(false)
    })
    wavesurferInstance.on('play', () => {
      playerControlsRef.value?.setPlayingValue(true)
      cancelPreloadTimer()
      preloadTimerId = setTimeout(() => {
        preloadNextSong()
        preloadTimerId = null
      }, 3000)
    })

    // 修改错误事件处理，增加 ignoreNextEmptyError 逻辑
    wavesurferInstance.on('error', async (error) => {
      // @ts-ignore - 尝试获取错误码
      const errorCode = error?.code

      // **新增：精确忽略来自 empty() 的 MediaError code 4**
      if (errorCode === 4 && ignoreNextEmptyError) {
        ignoreNextEmptyError = false // 重置标志
        return
      }

      // 如果正在进行文件操作并且是预期的 MediaError code 4，则忽略
      // (保留此检查作为后备，尽管上面的检查更精确)
      if (isFileOperationInProgress && errorCode === 4) {
        return
      }

      if (isFileOperationInProgress) {
        return
      }

      // 从错误对象获取更多信息（如果可能）
      console.error('WaveSurfer错误:', error) // 保留 Error
      try {
        // @ts-ignore - 尝试获取原始错误
        console.error('错误详情:', error?.originalError || error) // 保留 Error
      } catch (e) {
        // 忽略可能的类型错误
      }

      // 获取当前文件路径，如果不存在则传递 null
      const currentPath = runtime.playingData.playingSong?.filePath ?? null
      // 注意：不再直接调用 handleSongLoadError 来避免弹窗
      // await handleSongLoadError(currentPath, false);
      // 如果真的发生意外错误，考虑是否需要不同的处理方式，例如仅记录日志或显示一个不可交互的提示
      console.error(`发生未处理的播放器错误，歌曲路径: ${currentPath}`) // 保留 Error
      // 可以选择在这里清空播放器状态，如果需要的话
      // isInternalSongChange.value = true;
      // runtime.playingData.playingSong = null;
      // runtime.playingData.playingSongListUUID = '';
      // waveformShow.value = false;
      // bpm.value = 'N/A';
      // if (wavesurferInstance) wavesurferInstance.empty();
    })

    // --- 预加载实例事件监听 (移到 preloadNextSong 内部首次创建时) ---
    // preloadWavesurferInstance.on('ready', () => { ... });
    // preloadWavesurferInstance.on('error', (error) => { ... });
  }
  // 注册 IPC 监听器 (保持不变)
  window.electron.ipcRenderer.on(
    'readedSongFile',
    (event, audioData: Uint8Array, filePath: string, requestId?: number) => {
      // 检查请求ID是否匹配当前最新请求
      if (requestId && requestId !== currentLoadRequestId) {
        return
      }

      // 确保这是对当前请求歌曲的响应
      if (filePath === runtime.playingData.playingSong?.filePath) {
        // 调用 handleLoadBlob 时传递请求ID
        handleLoadBlob(new Blob([audioData]), filePath, requestId || currentLoadRequestId)
      } else {
      }
    }
  )
  window.electron.ipcRenderer.on(
    'readedNextSongFile',
    (event, audioData: Uint8Array, filePath: string, requestId?: number) => {
      // 检查请求ID是否匹配当前最新预加载请求
      if (requestId && requestId !== currentPreloadRequestId) {
        return
      }

      // 检查预加载实例是否仍然存在
      if (!preloadWavesurferInstance) {
        return
      }

      // 检查路径是否匹配
      if (filePath === preloadedSongFilePath) {
        try {
          preloadedBlob = new Blob([audioData])
          // 确保这个文件的预加载没有被取消
          if (isPreloading && preloadWavesurferInstance && filePath === preloadedSongFilePath) {
            preloadWavesurferInstance.loadBlob(preloadedBlob)
          } else {
            preloadedBlob = null
          }
        } catch (error) {
          console.error(`预加载音频数据处理错误:`, error) // 保留 Error
          handleSongLoadError(filePath, true)
        }
      } else {
      }
    }
  )

  // 添加预加载错误处理监听器
  window.electron.ipcRenderer.on(
    'readNextSongFileError',
    (event, filePath: string, errorMessage: string, requestId?: number) => {
      // 检查请求ID是否匹配当前最新预加载请求
      if (requestId && requestId !== currentPreloadRequestId) {
        return
      }

      console.error(`预加载歌曲失败: ${filePath}, 错误: ${errorMessage}`) // 保留 Error
      if (filePath === preloadedSongFilePath) {
        handleSongLoadError(filePath, true)
      }
    }
  )

  // 为主歌曲加载添加错误处理
  window.electron.ipcRenderer.on(
    'readSongFileError',
    (event, filePath: string, errorMessage: string, requestId?: number) => {
      // 检查请求ID是否匹配当前最新加载请求
      if (requestId && requestId !== currentLoadRequestId) {
        return
      }

      console.error(`加载歌曲失败: ${filePath}, 错误: ${errorMessage}`) // 保留 Error
      handleSongLoadError(filePath, false)
    }
  )

  // 注册其他 listeners... (hotkeys, resize, etc.)
  hotkeys('space', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (wavesurferInstance?.isPlaying()) {
      pause()
    } else {
      play()
    }
    return false
  })

  hotkeys('d,right', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    fastForward()

    return false
  })
  hotkeys('a,left', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    fastBackward()

    return false
  })
  hotkeys('s,down', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (runtime.selectSongListDialogShow) {
      return
    }
    nextSong()

    return false
  })
  hotkeys('w,up', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (runtime.selectSongListDialogShow) {
      return
    }
    previousSong()

    return false
  })
  hotkeys('F,delete', 'windowGlobal', (keyEvent) => {
    if (!waveformShow.value) {
      return
    }
    if (keyEvent.code === 'Delete' && runtime.songsArea.selectedSongFilePath.length > 0) {
      return
    }
    if (showDelConfirm || runtime.confirmShow) {
      return
    }
    runtime.activeMenuUUID = ''
    showDelConfirm = true
    delSong()
  })

  hotkeys('q', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (!runtime.selectSongListDialogShow) {
      moveToListLibrary()
    }
  })

  hotkeys('e', 'windowGlobal', () => {
    if (!waveformShow.value) {
      return
    }
    if (!runtime.selectSongListDialogShow) {
      moveToLikeLibrary()
    }
  })

  // 可能需要延迟获取宽度，等待 wavesurfer 渲染完成
  setTimeout(updateWaveformWidth, 500)
  window.addEventListener('resize', updateWaveformWidth)

  // 如果 wavesurferInstance 已经创建，监听其 ready 事件
  if (wavesurferInstance) {
    wavesurferInstance.on('ready', () => {
      updateWaveformWidth()
      startHandleLeftPercent.value = runtime.setting.startPlayPercent ?? 0
      endHandleLeftPercent.value = runtime.setting.endPlayPercent ?? 100
    })
  }
})

// 修改 watch 以处理 newSong === null 的情况
watch(
  () => runtime.playingData.playingSong,
  (newSong, oldSong) => {
    if (isInternalSongChange.value) {
      isInternalSongChange.value = false
      return
    }

    cancelPreloadTimer()

    if (newSong === null) {
      // **修改：在调用 empty() 前设置标志**
      if (wavesurferInstance) {
        ignoreNextEmptyError = true
        wavesurferInstance.empty()
      }
      waveformShow.value = false
      // **移除多余的 empty() 调用**
      // wavesurferInstance?.empty()

      if (preloadWavesurferInstance) {
        preloadWavesurferInstance.destroy()
        preloadWavesurferInstance = null
      }
      runtime.playingData.playingSongListUUID = ''
      preloadedBlob = null
      preloadedSongFilePath = null
      isPreloading = false
      isPreloadReady = false
      bpm.value = '' // 清空BPM
    } else if (newSong?.filePath !== oldSong?.filePath) {
      // 仅处理手动切换 或 内部切换后需要加载新歌的情况

      if (newSong.filePath === preloadedSongFilePath && isPreloadReady && preloadedBlob) {
        const blobToLoad = preloadedBlob

        preloadedBlob = null
        preloadedSongFilePath = null
        isPreloading = false
        isPreloadReady = false
        if (preloadWavesurferInstance) {
          preloadWavesurferInstance.destroy()
          preloadWavesurferInstance = null
        }
        // **修改：确保 requestId 传递正确**
        handleLoadBlob(blobToLoad, newSong.filePath, currentLoadRequestId) // 这里需要确认是否应该用 currentLoadRequestId 还是生成新的
      } else {
        isPreloading = false
        isPreloadReady = false
        preloadedBlob = null
        preloadedSongFilePath = null
        if (preloadWavesurferInstance) {
          preloadWavesurferInstance.destroy()
          preloadWavesurferInstance = null
        }
        requestLoadSong(newSong.filePath)
      }
    }
  }
)
onUnmounted(() => {
  cancelPreloadTimer()
  if (wavesurferInstance) {
    wavesurferInstance.destroy()
    wavesurferInstance = null
  }
  if (preloadWavesurferInstance) {
    preloadWavesurferInstance.destroy()
    preloadWavesurferInstance = null
  }
  window.electron.ipcRenderer.removeAllListeners('readedSongFile')
  window.electron.ipcRenderer.removeAllListeners('readedNextSongFile')
  window.electron.ipcRenderer.removeAllListeners('readNextSongFileError')
  window.electron.ipcRenderer.removeAllListeners('readSongFileError')
  window.removeEventListener('resize', updateWaveformWidth)
  hotkeys.unbind()
})

const songInfoShow = ref(false)
const coverBlobUrl = ref('')
const audioContext = new AudioContext()
const bpm = ref<number | string>('')

// 修改 requestLoadSong 以添加请求ID
const requestLoadSong = (filePath: string) => {
  // 如果正在进行文件操作，不加载新的歌曲
  if (isFileOperationInProgress) {
    return
  }

  cancelPreloadTimer()
  isPreloading = false
  isPreloadReady = false
  preloadedBlob = null
  preloadedSongFilePath = null

  if (preloadWavesurferInstance) {
    preloadWavesurferInstance.destroy()
    preloadWavesurferInstance = null
  }

  // 生成新的请求ID
  currentLoadRequestId++
  window.electron.ipcRenderer.send('readSongFile', filePath, currentLoadRequestId)
}

// 修改 handleLoadBlob 以接收和使用请求ID
const handleLoadBlob = async (blob: Blob, filePath: string, requestId: number) => {
  // 检查请求ID是否仍然是最新的
  if (requestId !== currentLoadRequestId) {
    return
  }

  if (!wavesurferInstance || runtime.playingData.playingSong?.filePath !== filePath) {
    return
  }

  // 更新歌曲信息和封面
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
    // 先加载音频
    await wavesurferInstance.loadBlob(blob)

    // 检查请求ID是否仍然是最新的
    if (requestId !== currentLoadRequestId) {
      return
    }

    // 确保当前播放的仍然是期望播放的歌曲
    if (runtime.playingData.playingSong?.filePath !== filePath) {
      return
    }

    try {
      if (runtime.setting.enablePlaybackRange && wavesurferInstance) {
        const duration = wavesurferInstance.getDuration()
        const startPercent = runtime.setting.startPlayPercent ?? 0
        const startTime = (duration * startPercent) / 100
        wavesurferInstance.play(startTime)
      } else {
        wavesurferInstance?.play()
      }
    } catch (playError: any) {
      if (playError.name === 'AbortError') {
        console.info('播放被中断，可能是因为快速切换歌曲') // 保留 Info
      } else {
        throw playError
      }
    }

    // --- BPM Analysis (remains the same, wrapped in its own try...catch) ---
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
            console.error('Error decoding audio data for BPM:', decodeError) // 保留 Error
            if (runtime.playingData.playingSong?.filePath === filePath) {
              bpm.value = 'N/A'
            }
          }
        })
        .catch((bufferError) => {
          console.error('Error getting array buffer from blob for BPM:', bufferError) // 保留 Error
          if (runtime.playingData.playingSong?.filePath === filePath) {
            bpm.value = 'N/A'
          }
        })
    } catch (e) {
      console.error('Error initiating BPM analysis:', e) // 保留 Error
      if (runtime.playingData.playingSong?.filePath === filePath) {
        bpm.value = 'N/A'
      }
    }
    // --- End BPM Analysis ---
  } catch (loadError) {
    console.error(`Error loading blob or starting playback for ${filePath}:`, loadError) // 保留 Error
    if ((loadError as any)?.name !== 'AbortError') {
      await handleSongLoadError(filePath, false)
    }
  }
}

// 修改 preloadNextSong 以添加请求ID
const preloadNextSong = () => {
  // 基本条件检查 (保持不变)
  if (isPreloading || !runtime.playingData.playingSong || !preloadWaveform.value) return

  // 查找下一首歌 (保持不变)
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

  // 检查是否需要预加载 (保持不变)
  if (nextSongFilePath === preloadedSongFilePath && isPreloadReady) {
    return
  }
  if (nextSongFilePath === preloadedSongFilePath && isPreloading) {
    return
  }

  // --- 销毁旧的预加载实例 (如果存在) ---
  if (preloadWavesurferInstance) {
    try {
      preloadWavesurferInstance.destroy()
    } catch (e) {
      console.error('Error destroying previous preload instance:', e) // 保留 Error
    }
    preloadWavesurferInstance = null // 明确设为 null
  }

  // --- 创建新的预加载实例 ---
  if (!preloadWaveform.value) {
    // 再次检查，以防万一
    return
  }
  try {
    preloadWavesurferInstance = createWaveSurferInstance(preloadWaveform.value)

    // 先设置预加载文件路径，确保监听器能正确引用
    preloadedSongFilePath = nextSongFilePath
    isPreloading = true
    isPreloadReady = false
    preloadedBlob = null

    // 生成新的预加载请求ID
    currentPreloadRequestId++
    const requestId = currentPreloadRequestId

    // **为新实例添加监听器**
    preloadWavesurferInstance.on('ready', () => {
      // 检查当前预加载的文件是否仍然是我们期望的
      if (preloadedSongFilePath === nextSongFilePath && preloadWavesurferInstance) {
        isPreloading = false
        isPreloadReady = true
      } else {
      }
    })
    preloadWavesurferInstance.on('error', (error) => {
      console.error('预加载Wavesurfer错误:', error, preloadedSongFilePath) // 保留 Error
      if (preloadedSongFilePath === nextSongFilePath) {
        handleSongLoadError(preloadedSongFilePath, true)
      }
    })

    // 发送预加载请求，包含请求ID
    window.electron.ipcRenderer.send('readNextSongFile', nextSongFilePath, requestId)
  } catch (createError) {
    console.error('Error creating preload wavesurfer instance:', createError) // 保留 Error
    preloadWavesurferInstance = null
    isPreloading = false
    preloadedSongFilePath = null // 重置路径
    return
  }
}

const play = () => {
  wavesurferInstance?.play()
}
const pause = () => {
  wavesurferInstance?.pause()
}

const fastForward = () => {
  wavesurferInstance?.skip(runtime.setting.fastForwardTime)
}

const fastBackward = () => {
  wavesurferInstance?.skip(runtime.setting.fastBackwardTime)
}

const nextSong = () => {
  cancelPreloadTimer()
  if (!runtime.playingData.playingSong) return
  const currentIndex = runtime.playingData.playingSongListData.findIndex(
    (item) => item.filePath === runtime.playingData.playingSong?.filePath
  )
  if (currentIndex === -1 || currentIndex >= runtime.playingData.playingSongListData.length - 1) {
    return
  }
  const nextIndex = currentIndex + 1
  const nextSongData = runtime.playingData.playingSongListData[nextIndex]
  if (!nextSongData) return
  const nextSongFilePath = nextSongData.filePath

  if (wavesurferInstance?.isPlaying()) {
    wavesurferInstance.stop()
  }

  if (preloadedSongFilePath === nextSongFilePath && preloadedBlob && isPreloadReady) {
    const blobToLoad = preloadedBlob
    isInternalSongChange.value = true
    runtime.playingData.playingSong = nextSongData
    preloadedBlob = null
    preloadedSongFilePath = null
    isPreloading = false
    isPreloadReady = false
    preloadWavesurferInstance?.destroy()
    preloadWavesurferInstance = null
    handleLoadBlob(blobToLoad, nextSongFilePath, currentLoadRequestId)
  } else {
    preloadedBlob = null
    preloadedSongFilePath = null
    isPreloading = false
    isPreloadReady = false
    preloadWavesurferInstance?.destroy()
    preloadWavesurferInstance = null
    isInternalSongChange.value = true
    runtime.playingData.playingSong = nextSongData
    requestLoadSong(nextSongFilePath)
  }
}

const previousSong = () => {
  cancelPreloadTimer()
  if (!runtime.playingData.playingSong) return

  const currentIndex = runtime.playingData.playingSongListData.findIndex(
    (item) => item.filePath === runtime.playingData.playingSong?.filePath
  )
  if (currentIndex <= 0) {
    return
  }

  const prevIndex = currentIndex - 1
  const prevSongData = runtime.playingData.playingSongListData[prevIndex]
  if (!prevSongData) return

  const prevSongFilePath = prevSongData.filePath

  if (wavesurferInstance?.isPlaying()) {
    wavesurferInstance.stop()
  }

  // 清理预加载状态
  preloadedBlob = null
  preloadedSongFilePath = null
  isPreloading = false
  isPreloadReady = false
  preloadWavesurferInstance?.destroy()
  preloadWavesurferInstance = null
  isInternalSongChange.value = true
  runtime.playingData.playingSong = prevSongData
  requestLoadSong(prevSongFilePath)
}
let showDelConfirm = false

// 修改 delSong 函数，设置 ignoreNextEmptyError
const delSong = async () => {
  if (isFileOperationInProgress || !runtime.playingData.playingSong) {
    return
  }

  isFileOperationInProgress = true
  const filePathToDelete = runtime.playingData.playingSong.filePath

  try {
    cancelPreloadTimer()

    const currentSongListUUID = runtime.playingData.playingSongListUUID
    const currentList = runtime.playingData.playingSongListData
    const currentIndex = currentList.findIndex((item) => item.filePath === filePathToDelete)

    if (currentIndex === -1) {
      console.error(`[delSong] 未找到要删除的歌曲: ${filePathToDelete}`) // 保留 Error
      isFileOperationInProgress = false
      return
    }

    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === '回收站')
      ?.children?.find((item) => item.uuid === currentSongListUUID)

    let performDelete = false
    let permanently = false

    // --- 用户确认逻辑 (保持不变) ---
    if (isInRecycleBin) {
      const res = await confirm({
        title: '删除',
        content: [
          t('确定彻底删除正在播放的曲目吗'),
          t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
        ]
      })
      showDelConfirm = false
      if (res === 'confirm') {
        performDelete = true
        permanently = true
      }
    } else {
      showDelConfirm = false
      performDelete = true
      permanently = false
    }
    // --- 用户确认逻辑结束 ---

    if (!performDelete) {
      isFileOperationInProgress = false
      return
    }

    // 1. 停止播放并准备清空播放器
    if (wavesurferInstance) {
      if (wavesurferInstance.isPlaying()) {
        wavesurferInstance.pause()
      }

      ignoreNextEmptyError = true // 设置标志

      wavesurferInstance.empty()
    }
    waveformShow.value = false
    bpm.value = ''

    // 清理预加载 (保持不变)
    preloadedBlob = null
    preloadedSongFilePath = null
    isPreloading = false
    isPreloadReady = false
    if (preloadWavesurferInstance) {
      preloadWavesurferInstance.destroy()
      preloadWavesurferInstance = null
    }

    // 2. 从列表中移除当前歌曲

    currentList.splice(currentIndex, 1)

    // 3. 确定下一首歌曲
    let nextPlayingSong = null
    if (currentList.length > 0) {
      const nextIndex = Math.min(currentIndex, currentList.length - 1)
      nextPlayingSong = currentList[nextIndex]
    } else {
    }

    // 4. 更新 Pinia 状态

    isInternalSongChange.value = true
    runtime.playingData.playingSong = nextPlayingSong

    // 5. 执行文件删除

    const deletePromise = permanently
      ? window.electron.ipcRenderer.invoke('permanentlyDelSongs', [filePathToDelete])
      : window.electron.ipcRenderer.send('delSongs', [filePathToDelete], getCurrentTimeDirName())
    await Promise.resolve(deletePromise)

    // 6. 准备加载下一首
    await nextTick()

    if (nextPlayingSong) {
      isFileOperationInProgress = false

      requestLoadSong(nextPlayingSong.filePath)
    } else {
      runtime.playingData.playingSongListUUID = ''

      isFileOperationInProgress = false
    }
  } catch (error) {
    console.error(`[delSong] 删除歌曲过程中发生错误 (${filePathToDelete}):`, error) // 保留 Error
    ignoreNextEmptyError = false // 出错时也重置标志
    isFileOperationInProgress = false
  }
}

const selectSongListDialogLibraryName = ref('筛选库')
const selectSongListDialogShow = ref(false)

const moveToListLibrary = () => {
  selectSongListDialogLibraryName.value = '筛选库'
  selectSongListDialogShow.value = true
}

const moveToLikeLibrary = () => {
  selectSongListDialogLibraryName.value = '精选库'
  selectSongListDialogShow.value = true
}

// 修改 selectSongListDialogConfirm 函数，设置 ignoreNextEmptyError
const selectSongListDialogConfirm = async (item: string) => {
  if (isFileOperationInProgress || !runtime.playingData.playingSong) {
    return
  }
  if (item === runtime.playingData.playingSongListUUID) {
    return
  }

  isFileOperationInProgress = true
  const filePathToMove = runtime.playingData.playingSong.filePath
  const targetDirPath = libraryUtils.findDirPathByUuid(item)

  if (!targetDirPath) {
    console.error(`[moveSong] 未找到目标目录路径: ${item}`) // 保留 Error
    isFileOperationInProgress = false
    return
  }

  try {
    cancelPreloadTimer()
    selectSongListDialogShow.value = false

    const currentList = runtime.playingData.playingSongListData
    const currentIndex = currentList.findIndex((song) => song.filePath === filePathToMove)

    if (currentIndex === -1) {
      console.error(`[moveSong] 未找到要移动的歌曲: ${filePathToMove}`) // 保留 Error
      isFileOperationInProgress = false
      return
    }

    // 1. 停止播放并准备清空播放器
    if (wavesurferInstance) {
      if (wavesurferInstance.isPlaying()) {
        wavesurferInstance.pause()
      }

      ignoreNextEmptyError = true // 设置标志

      wavesurferInstance.empty()
    }
    waveformShow.value = false
    bpm.value = ''

    // 清理预加载 (保持不变)
    preloadedBlob = null
    preloadedSongFilePath = null
    isPreloading = false
    isPreloadReady = false
    if (preloadWavesurferInstance) {
      preloadWavesurferInstance.destroy()
      preloadWavesurferInstance = null
    }

    // 2. 从列表中移除当前歌曲

    currentList.splice(currentIndex, 1)

    // 3. 确定下一首歌曲
    let nextPlayingSong = null
    if (currentList.length > 0) {
      const nextIndex = Math.min(currentIndex, currentList.length - 1)
      nextPlayingSong = currentList[nextIndex]
    } else {
    }

    // 4. 更新 Pinia 状态

    isInternalSongChange.value = true
    runtime.playingData.playingSong = nextPlayingSong

    // 5. 执行文件移动

    await window.electron.ipcRenderer.invoke('moveSongsToDir', [filePathToMove], targetDirPath)

    // 6. 刷新列表显示
    if (item === runtime.songsArea.songListUUID) {
      runtime.songsArea.songListUUID = ''
      await nextTick(() => {
        runtime.songsArea.songListUUID = item
      })
    }

    // 7. 准备加载下一首
    await nextTick()

    if (nextPlayingSong) {
      isFileOperationInProgress = false

      requestLoadSong(nextPlayingSong.filePath)
    } else {
      runtime.playingData.playingSongListUUID = ''

      isFileOperationInProgress = false
    }
  } catch (error) {
    console.error(`[moveSong] 移动歌曲过程中发生错误 (${filePathToMove}):`, error) // 保留 Error
    ignoreNextEmptyError = false // 出错时也重置标志
    isFileOperationInProgress = false
  }
}

const exportTrack = async () => {
  cancelPreloadTimer()
  if (!runtime.playingData.playingSong) {
    console.error('Cannot export, no song is playing.') // 保留 Error
    return
  }
  let result = await exportDialog({ title: '曲目' })
  if (result !== 'cancel') {
    let folderPathVal = result.folderPathVal
    let deleteSongsAfterExport = result.deleteSongsAfterExport
    const songToExport = JSON.parse(JSON.stringify(runtime.playingData.playingSong)) // 传递副本
    const filePath = songToExport.filePath // 保存文件路径
    const currentList = runtime.playingData.playingSongListData // 保存列表引用
    const currentIndex = currentList.findIndex((item) => item.filePath === filePath)

    try {
      await window.electron.ipcRenderer.invoke(
        'exportSongsToDir',
        folderPathVal,
        deleteSongsAfterExport,
        [songToExport] // 传递包含副本的数组
      )
      if (deleteSongsAfterExport) {
        if (currentIndex !== -1) {
          wavesurferInstance?.stop()
          wavesurferInstance?.empty()
          waveformShow.value = false
          bpm.value = ''
          preloadedBlob = null
          preloadedSongFilePath = null
          isPreloading = false
          isPreloadReady = false
          preloadWavesurferInstance?.destroy()
          currentList.splice(currentIndex, 1)
          let nextPlayingSong = null
          if (currentList.length > 0) {
            const nextIndex = Math.min(currentIndex, currentList.length - 1)
            nextPlayingSong = currentList[nextIndex]
          }
          runtime.playingData.playingSong = nextPlayingSong
          if (nextPlayingSong) {
            requestLoadSong(nextPlayingSong.filePath)
          } else {
            runtime.playingData.playingSongListUUID = ''
          }
        }
      }
    } catch (error) {
      console.error('Error exporting track:', error) // 保留 Error
    }
  }
}

const bpmDomRef = useTemplateRef('bpmDomRef')

// 手动把手位置状态
const startHandleRef = useTemplateRef<HTMLDivElement>('startHandleRef') // 获取 DOM 引用
const endHandleRef = useTemplateRef<HTMLDivElement>('endHandleRef') // 获取 DOM 引用
const startHandleLeftPercent = ref(0) // 初始为 0%
const endHandleLeftPercent = ref(100) // 初始为 100%

// --- 拖拽逻辑状态 ---
const isDraggingStart = ref(false)
const isDraggingEnd = ref(false)
const dragStartX = ref(0)
const waveformContainerWidth = ref(0)
const startPercentAtDragStart = ref(0)
const endPercentAtDragStart = ref(0)

// --- 拖拽处理函数 ---

// 获取波形容器宽度 (需要在 onMounted 和窗口 resize 时更新)
const updateWaveformWidth = () => {
  const waveformEl = wavesurferInstance?.getWrapper()
  if (waveformEl) {
    waveformContainerWidth.value = waveformEl.clientWidth
  } else {
    waveformContainerWidth.value = 0 // 重置以防万一
  }
}

// 全局 mousemove 处理
const handleGlobalMouseMove = (event: MouseEvent) => {
  if ((!isDraggingStart.value && !isDraggingEnd.value) || waveformContainerWidth.value <= 0) return
  const currentX = event.clientX
  const deltaX = currentX - dragStartX.value
  const deltaPercent = (deltaX / waveformContainerWidth.value) * 100

  if (isDraggingStart.value) {
    let newStartPercent = startPercentAtDragStart.value + deltaPercent
    newStartPercent = Math.max(0, newStartPercent)
    newStartPercent = Math.min((runtime.setting.endPlayPercent ?? 100) - 1, newStartPercent)
    runtime.setting.startPlayPercent = newStartPercent
  } else if (isDraggingEnd.value) {
    let newEndPercent = endPercentAtDragStart.value + deltaPercent
    newEndPercent = Math.max((runtime.setting.startPlayPercent ?? 0) + 1, newEndPercent)
    newEndPercent = Math.min(100, newEndPercent)
    runtime.setting.endPlayPercent = newEndPercent
  }
}

// --- 新增：保存设置函数 ---
const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

// 全局 mouseup 处理
const handleGlobalMouseUp = () => {
  if (isDraggingStart.value || isDraggingEnd.value) {
    isDraggingStart.value = false
    isDraggingEnd.value = false
    window.removeEventListener('mousemove', handleGlobalMouseMove)
    window.removeEventListener('mouseup', handleGlobalMouseUp)

    // 拖拽结束后保存设置
    setSetting()
  }
}

// 把手 mousedown 处理
const handleMouseDown = (event: MouseEvent, handleType: 'start' | 'end') => {
  event.preventDefault()
  event.stopPropagation()

  updateWaveformWidth() // 确保获取最新宽度
  if (waveformContainerWidth.value <= 0) {
    return
  }

  dragStartX.value = event.clientX
  startPercentAtDragStart.value = runtime.setting.startPlayPercent ?? 0
  endPercentAtDragStart.value = runtime.setting.endPlayPercent ?? 100

  if (handleType === 'start') {
    isDraggingStart.value = true
  } else {
    isDraggingEnd.value = true
  }

  window.addEventListener('mousemove', handleGlobalMouseMove)
  window.addEventListener('mouseup', handleGlobalMouseUp)
}

// 监听 setting 百分比变化，更新把手位置
watch(
  () => [runtime.setting.startPlayPercent, runtime.setting.endPlayPercent],
  ([start, end]) => {
    startHandleLeftPercent.value = start ?? 0
    endHandleLeftPercent.value = end ?? 100
  },
  { immediate: true } // immediate: true 确保初始加载时也执行一次
)

// 当波形图显示/隐藏时，也同步一次状态（或根据需要处理）
watch(waveformShow, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      // 确保 DOM 更新后再获取宽度
      updateWaveformWidth()
      startHandleLeftPercent.value = runtime.setting.startPlayPercent ?? 0
      endHandleLeftPercent.value = runtime.setting.endPlayPercent ?? 100
    })
  } else {
    // 可选：隐藏时重置或保持状态
  }
})
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
        @pause="pause"
        @play="play"
        @fastForward="fastForward"
        @fastBackward="fastBackward"
        @nextSong="nextSong"
        @previousSong="previousSong"
        @delSong="delSong"
        @moveToListLibrary="moveToListLibrary"
        @moveToLikeLibrary="moveToLikeLibrary"
        @exportTrack="exportTrack"
      />
    </div>

    <div style="flex-grow: 1; position: relative" class="unselectable">
      <!-- 主波形容器 -->
      <div id="waveform" ref="waveform" v-show="waveformShow">
        <div id="time">0:00</div>
        <div id="duration">0:00</div>
        <div id="hover"></div>
      </div>
      <!-- 隐藏的预加载波形容器 -->
      <div id="preload-waveform" ref="preloadWaveform" style="display: none"></div>

      <div
        v-show="waveformShow && runtime.setting.enablePlaybackRange"
        class="manual-handle start-handle"
        ref="startHandleRef"
        :style="{ left: startHandleLeftPercent + '%' }"
        @mousedown="(event) => handleMouseDown(event, 'start')"
      ></div>
      <div
        v-show="waveformShow && runtime.setting.enablePlaybackRange"
        class="manual-handle end-handle"
        ref="endHandleRef"
        :style="{ left: endHandleLeftPercent + '%' }"
        @mousedown="(event) => handleMouseDown(event, 'end')"
      ></div>
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
  /* 确保主波形图有高度 */
  min-height: 40px;
  /* 或者等于 wavesurfer 的 height */
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

.manual-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  cursor: default;
  z-index: 12;
}

.manual-handle::before,
.manual-handle::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  background-color: currentColor;
  cursor: ew-resize;
  opacity: 0.9;
}

.manual-handle::before {
  top: 0;
}

.manual-handle::after {
  bottom: 0;
}

.start-handle {
  color: #2ecc71;
  background-color: #2ecc71;
}

.start-handle::before,
.start-handle::after {
  right: 50%;
}

.end-handle {
  color: #e74c3c;
  background-color: #e74c3c;
}

.end-handle::before,
.end-handle::after {
  left: 50%;
}

.manual-handle:hover::before,
.manual-handle:hover::after,
.manual-handle.dragging::before,
.manual-handle.dragging::after {
  opacity: 1;
}
</style>
