import { ref, nextTick, type Ref } from 'vue'
import type WaveSurfer from 'wavesurfer.js'
import { type ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import exportDialog from '@renderer/components/exportDialog'
import libraryUtils from '@renderer/utils/libraryUtils'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'

// 定义 usePlayerControls 的参数类型
interface UsePlayerControlsOptions {
  wavesurferInstance: Ref<WaveSurfer | null>
  preloadWavesurferInstance: Ref<WaveSurfer | null>
  runtime: ReturnType<typeof useRuntimeStore>
  bpm: Ref<number | string>
  waveformShow: Ref<boolean>
  selectSongListDialogShow: Ref<boolean>
  selectSongListDialogLibraryName: Ref<string>
  isInternalSongChange: Ref<boolean>
  requestLoadSong: (filePath: string) => void
  handleLoadBlob: (blob: Blob, filePath: string, requestId: number) => Promise<void>
  cancelPreloadTimer: () => void
  currentLoadRequestId: Ref<number>
  preloadedBlob: Ref<Blob | null>
  preloadedSongFilePath: Ref<string | null>
  isPreloading: Ref<boolean>
  isPreloadReady: Ref<boolean>
  ignoreNextEmptyError: Ref<boolean>
}

export function usePlayerControlsLogic({
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
}: UsePlayerControlsOptions) {
  const isFileOperationInProgress = ref(false)

  const play = () => {
    wavesurferInstance.value?.play()
  }
  const pause = () => {
    wavesurferInstance.value?.pause()
  }

  const togglePlayPause = () => {
    if (wavesurferInstance.value?.isPlaying()) {
      pause()
    } else {
      play()
    }
  }

  const fastForward = () => {
    wavesurferInstance.value?.skip(runtime.setting.fastForwardTime)
  }

  const fastBackward = () => {
    // 注意：wavesurfer 的 skip 方法接受正数表示前进，负数表示后退
    wavesurferInstance.value?.skip(-runtime.setting.fastBackwardTime)
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

    if (wavesurferInstance.value?.isPlaying()) {
      wavesurferInstance.value.stop()
    }

    // 检查预加载是否命中
    if (
      preloadedSongFilePath.value === nextSongFilePath &&
      preloadedBlob.value &&
      isPreloadReady.value
    ) {
      // 命中预加载
      console.log('[NextSong] 切歌: 使用预加载数据 -', nextSongFilePath) // 添加日志
      const blobToLoad = preloadedBlob.value
      isInternalSongChange.value = true // 标记内部切换
      runtime.playingData.playingSong = nextSongData
      // 清理预加载状态
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      preloadWavesurferInstance.value?.destroy()
      preloadWavesurferInstance.value = null
      // 加载 blob
      handleLoadBlob(blobToLoad, nextSongFilePath, currentLoadRequestId.value)
    } else {
      // 未命中预加载或预加载未就绪
      console.log('[NextSong] 切歌: 未使用预加载，直接加载 -', nextSongFilePath) // 添加日志
      // 清理预加载状态（以防万一）
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      preloadWavesurferInstance.value?.destroy()
      preloadWavesurferInstance.value = null
      // 设置内部切换并请求加载
      isInternalSongChange.value = true // 标记内部切换
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
      // 如果是第一首，或者找不到，则不执行任何操作
      return
    }

    const prevIndex = currentIndex - 1
    const prevSongData = runtime.playingData.playingSongListData[prevIndex]
    if (!prevSongData) return

    const prevSongFilePath = prevSongData.filePath

    if (wavesurferInstance.value?.isPlaying()) {
      wavesurferInstance.value.stop()
    }

    // 切换到上一首时，总是重新加载，不使用预加载
    preloadedBlob.value = null
    preloadedSongFilePath.value = null
    isPreloading.value = false
    isPreloadReady.value = false
    preloadWavesurferInstance.value?.destroy()
    preloadWavesurferInstance.value = null
    isInternalSongChange.value = true // 标记内部切换
    runtime.playingData.playingSong = prevSongData
    requestLoadSong(prevSongFilePath)
  }

  const delSong = async () => {
    if (isFileOperationInProgress.value || !runtime.playingData.playingSong) {
      return
    }

    isFileOperationInProgress.value = true
    const filePathToDelete = runtime.playingData.playingSong.filePath

    try {
      cancelPreloadTimer()

      const currentSongListUUID = runtime.playingData.playingSongListUUID
      const currentList = runtime.playingData.playingSongListData
      const currentIndex = currentList.findIndex((item) => item.filePath === filePathToDelete)

      if (currentIndex === -1) {
        console.error(`[delSong] 未找到要删除的歌曲: ${filePathToDelete}`)
        isFileOperationInProgress.value = false
        return
      }

      // 检查是否在回收站
      const isInRecycleBin = runtime.libraryTree.children
        ?.find((item) => item.dirName === '回收站')
        ?.children?.find((item) => item.uuid === currentSongListUUID)

      let performDelete = false
      let permanently = false

      if (isInRecycleBin) {
        // 在回收站，询问是否彻底删除
        const res = await confirm({
          title: '删除',
          content: [
            t('确定彻底删除正在播放的曲目吗'),
            t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
          ]
        })
        if (res === 'confirm') {
          performDelete = true
          permanently = true
        }
      } else {
        // 不在回收站，直接移动到回收站
        performDelete = true
        permanently = false
      }

      if (!performDelete) {
        isFileOperationInProgress.value = false
        return // 用户取消操作
      }

      // 停止播放并清空播放器
      if (wavesurferInstance.value) {
        if (wavesurferInstance.value.isPlaying()) {
          wavesurferInstance.value.pause() // 使用 pause 而不是 stop 避免潜在问题
        }
        // 在调用 empty 之前设置标志
        ignoreNextEmptyError.value = true
        wavesurferInstance.value.empty()
      }
      waveformShow.value = false
      bpm.value = '' // 清空 BPM 显示

      // 清理预加载状态
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      if (preloadWavesurferInstance.value) {
        preloadWavesurferInstance.value.destroy()
        preloadWavesurferInstance.value = null
      }

      // 从当前播放列表中移除歌曲
      currentList.splice(currentIndex, 1)

      // 确定下一首要播放的歌曲
      let nextPlayingSong: ISongInfo | null = null
      if (currentList.length > 0) {
        const nextIndex = Math.min(currentIndex, currentList.length - 1) // 如果删除的是最后一首，则播放新的最后一首
        nextPlayingSong = currentList[nextIndex]
      } else {
        // 列表为空
      }

      // 更新当前播放歌曲状态
      isInternalSongChange.value = true // 标记内部切换
      runtime.playingData.playingSong = nextPlayingSong

      // 执行删除操作（移动到回收站或彻底删除）
      const deletePromise = permanently
        ? window.electron.ipcRenderer.invoke('permanentlyDelSongs', [filePathToDelete])
        : window.electron.ipcRenderer.send('delSongs', [filePathToDelete], getCurrentTimeDirName())
      await Promise.resolve(deletePromise) // 等待删除操作完成

      await nextTick() // 等待 DOM 更新

      // 如果有下一首歌，加载它
      if (nextPlayingSong) {
        isFileOperationInProgress.value = false // 允许后续操作
        // 在这里不应再次设置 isInternalSongChange.value = false，因为它是由外部 watch 触发的
        requestLoadSong(nextPlayingSong.filePath)
      } else {
        // 如果列表空了，清空播放列表 UUID
        runtime.playingData.playingSongListUUID = ''
        isFileOperationInProgress.value = false // 允许后续操作
      }
    } catch (error) {
      console.error(`[delSong] 删除歌曲过程中发生错误 (${filePathToDelete}):`, error)
      // 出错时也应该重置标志，以防万一
      ignoreNextEmptyError.value = false
      isFileOperationInProgress.value = false // 允许后续操作
    }
  }

  const moveToListLibrary = () => {
    selectSongListDialogLibraryName.value = '筛选库'
    selectSongListDialogShow.value = true
  }

  const moveToLikeLibrary = () => {
    selectSongListDialogLibraryName.value = '精选库'
    selectSongListDialogShow.value = true
  }

  // 这个函数在 usePlayerControlsLogic 内部使用，不需要导出
  const handleMoveSong = async (targetListUuid: string) => {
    if (isFileOperationInProgress.value || !runtime.playingData.playingSong) {
      return
    }
    if (targetListUuid === runtime.playingData.playingSongListUUID) {
      // 移动到当前列表，无需操作
      return
    }

    isFileOperationInProgress.value = true
    const filePathToMove = runtime.playingData.playingSong.filePath
    const targetDirPath = libraryUtils.findDirPathByUuid(targetListUuid)

    if (!targetDirPath) {
      console.error(`[moveSong] 未找到目标目录路径: ${targetListUuid}`)
      isFileOperationInProgress.value = false
      return
    }

    try {
      cancelPreloadTimer() // 取消预加载
      selectSongListDialogShow.value = false // 关闭对话框

      const currentList = runtime.playingData.playingSongListData
      const currentIndex = currentList.findIndex((song) => song.filePath === filePathToMove)

      if (currentIndex === -1) {
        console.error(`[moveSong] 未找到要移动的歌曲: ${filePathToMove}`)
        isFileOperationInProgress.value = false
        return
      }

      // 停止播放并清空播放器
      if (wavesurferInstance.value) {
        if (wavesurferInstance.value.isPlaying()) {
          wavesurferInstance.value.pause()
        }
        // 在调用 empty 之前设置标志
        ignoreNextEmptyError.value = true
        wavesurferInstance.value.empty()
      }
      waveformShow.value = false
      bpm.value = '' // 清空 BPM

      // 清理预加载状态
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      if (preloadWavesurferInstance.value) {
        preloadWavesurferInstance.value.destroy()
        preloadWavesurferInstance.value = null
      }

      // 从当前播放列表中移除歌曲
      currentList.splice(currentIndex, 1)

      // 确定下一首要播放的歌曲
      let nextPlayingSong: ISongInfo | null = null
      if (currentList.length > 0) {
        const nextIndex = Math.min(currentIndex, currentList.length - 1)
        nextPlayingSong = currentList[nextIndex]
      } else {
        // 列表为空
      }

      // 更新当前播放歌曲状态
      isInternalSongChange.value = true // 标记内部切换
      runtime.playingData.playingSong = nextPlayingSong

      // 执行移动操作
      await window.electron.ipcRenderer.invoke('moveSongsToDir', [filePathToMove], targetDirPath)

      // 如果移动的目标列表是当前歌曲区域显示的列表，则需要刷新歌曲区域
      if (targetListUuid === runtime.songsArea.songListUUID) {
        // 强制刷新歌曲区域列表
        const currentSongsAreaUUID = runtime.songsArea.songListUUID
        runtime.songsArea.songListUUID = '' // 先设置为空
        await nextTick() // 等待DOM更新或其他异步操作
        runtime.songsArea.songListUUID = currentSongsAreaUUID // 再设置回来，触发更新
      }

      await nextTick() // 等待可能的其他更新

      // 如果有下一首歌，加载它
      if (nextPlayingSong) {
        isFileOperationInProgress.value = false // 允许后续操作
        requestLoadSong(nextPlayingSong.filePath)
      } else {
        // 如果列表空了，清空播放列表 UUID
        runtime.playingData.playingSongListUUID = ''
        isFileOperationInProgress.value = false // 允许后续操作
      }
    } catch (error) {
      console.error(`[moveSong] 移动歌曲过程中发生错误 (${filePathToMove}):`, error)
      // 出错时也应该重置标志
      ignoreNextEmptyError.value = false
      isFileOperationInProgress.value = false // 允许后续操作
    }
  }

  const exportTrack = async () => {
    cancelPreloadTimer() // 取消预加载
    if (!runtime.playingData.playingSong) {
      console.error('无法导出，没有歌曲正在播放。')
      return
    }

    // 弹出导出对话框
    let result = await exportDialog({ title: '曲目' })
    if (result !== 'cancel') {
      let folderPathVal = result.folderPathVal
      let deleteSongsAfterExport = result.deleteSongsAfterExport

      // 深拷贝当前播放歌曲信息，避免后续操作影响原始数据
      const songToExport = JSON.parse(JSON.stringify(runtime.playingData.playingSong))
      const filePath = songToExport.filePath
      const currentList = runtime.playingData.playingSongListData
      const currentIndex = currentList.findIndex((item) => item.filePath === filePath)

      try {
        // 调用后端导出功能
        await window.electron.ipcRenderer.invoke(
          'exportSongsToDir',
          folderPathVal,
          deleteSongsAfterExport,
          [songToExport] // 导出的是当前播放的这一首
        )

        // 如果设置了导出后删除
        if (deleteSongsAfterExport) {
          if (currentIndex !== -1) {
            // 停止播放并清空
            wavesurferInstance.value?.stop() // 使用 stop 确保完全停止
            wavesurferInstance.value?.empty()
            waveformShow.value = false
            bpm.value = ''

            // 清理预加载
            preloadedBlob.value = null
            preloadedSongFilePath.value = null
            isPreloading.value = false
            isPreloadReady.value = false
            preloadWavesurferInstance.value?.destroy()
            preloadWavesurferInstance.value = null

            // 从列表中删除
            currentList.splice(currentIndex, 1)

            // 确定下一首歌
            let nextPlayingSong: ISongInfo | null = null
            if (currentList.length > 0) {
              const nextIndex = Math.min(currentIndex, currentList.length - 1)
              nextPlayingSong = currentList[nextIndex]
            }

            // 更新播放状态
            isInternalSongChange.value = true
            runtime.playingData.playingSong = nextPlayingSong

            // 加载下一首歌或清空列表
            if (nextPlayingSong) {
              requestLoadSong(nextPlayingSong.filePath)
            } else {
              runtime.playingData.playingSongListUUID = ''
            }
          }
        }
      } catch (error) {
        console.error('导出曲目时出错:', error)
        // 这里可以添加用户提示
      }
    }
  }

  return {
    play,
    pause,
    togglePlayPause,
    fastForward,
    fastBackward,
    nextSong,
    previousSong,
    delSong,
    moveToListLibrary,
    moveToLikeLibrary,
    exportTrack,
    handleMoveSong // 暴露给父组件的 selectSongListDialogConfirm 使用
  }
}
