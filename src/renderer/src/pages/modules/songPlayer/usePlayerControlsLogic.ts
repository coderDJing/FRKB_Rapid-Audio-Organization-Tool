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
  runtime: ReturnType<typeof useRuntimeStore>
  bpm: Ref<number | string>
  waveformShow: Ref<boolean>
  selectSongListDialogShow: Ref<boolean>
  selectSongListDialogLibraryName: Ref<string>
  isInternalSongChange: Ref<boolean>
  requestLoadSong: (filePath: string) => void
  handleLoadBlob: (
    blob: Blob,
    filePath: string,
    requestId: number,
    preloadedBpmValue?: number | string | null // 保持可选，因为watch调用时传了，但非预加载时不传
  ) => Promise<void>
  cancelPreloadTimer: (reason?: string) => void
  currentLoadRequestId: Ref<number>
  preloadedBlob: Ref<Blob | null>
  preloadedSongFilePath: Ref<string | null>
  preloadedBpm: Ref<number | string | null> // 确保 preloadedBpm 可用
  isPreloading: Ref<boolean>
  isPreloadReady: Ref<boolean>
  ignoreNextEmptyError: Ref<boolean>
  clearReadyPreloadState: () => void
}

export function usePlayerControlsLogic({
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
  preloadedBpm, // 确保 preloadedBpm 被解构
  isPreloading,
  isPreloadReady,
  ignoreNextEmptyError,
  clearReadyPreloadState
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
    // 直接使用已经是负数的 fastBackwardTime
    wavesurferInstance.value?.skip(runtime.setting.fastBackwardTime)
  }

  const nextSong = () => {
    cancelPreloadTimer('nextSong start')
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
      const blobToLoad = preloadedBlob.value
      const bpmValueToUse = preloadedBpm.value // <-- 获取预加载的 BPM
      isInternalSongChange.value = true // 标记内部切换
      runtime.playingData.playingSong = nextSongData
      // 清理预加载状态
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      // 加载 blob，并传递预加载的 BPM
      handleLoadBlob(blobToLoad, nextSongFilePath, currentLoadRequestId.value, bpmValueToUse) // <-- 传递 BPM
    } else {
      // 未命中预加载或预加载未就绪
      // 清理预加载状态（以防万一）
      preloadedBlob.value = null
      preloadedSongFilePath.value = null
      isPreloading.value = false
      isPreloadReady.value = false
      // 设置内部切换并请求加载
      isInternalSongChange.value = true // 标记内部切换
      runtime.playingData.playingSong = nextSongData
      // 注意：这里调用 requestLoadSong，它内部会调用 handleLoadBlob（在 IPC 返回后），
      // 并且不会传递 preloadedBpmValue，这是符合预期的
      requestLoadSong(nextSongFilePath)
    }
  }

  const previousSong = () => {
    cancelPreloadTimer('previousSong start')
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
    // 设置内部切换并请求加载
    isInternalSongChange.value = true // 标记内部切换
    runtime.playingData.playingSong = prevSongData
    requestLoadSong(prevSongFilePath)
    clearReadyPreloadState()
  }

  const delSong = async () => {
    if (isFileOperationInProgress.value || !runtime.playingData.playingSong) {
      return
    }

    isFileOperationInProgress.value = true
    const filePathToDelete = runtime.playingData.playingSong.filePath

    try {
      cancelPreloadTimer('delSong start')

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

      // 从当前播放列表中移除歌曲
      currentList.splice(currentIndex, 1)

      // 确定下一首要播放的歌曲
      let nextPlayingSong: ISongInfo | null = null
      let nextPlayingSongPath: string | null = null
      if (currentList.length > 0) {
        const nextIndex = Math.min(currentIndex, currentList.length - 1) // 如果删除的是最后一首，则播放新的最后一首
        nextPlayingSong = currentList[nextIndex]
        nextPlayingSongPath = nextPlayingSong?.filePath ?? null
      }

      // 检查预加载是否命中
      if (
        nextPlayingSongPath &&
        isPreloadReady.value &&
        preloadedSongFilePath.value === nextPlayingSongPath &&
        preloadedBlob.value
      ) {
        // 命中预加载
        const blobToLoad = preloadedBlob.value
        const bpmValueToUse = preloadedBpm.value
        isInternalSongChange.value = true // 标记内部切换
        runtime.playingData.playingSong = nextPlayingSong // 更新当前播放歌曲

        // 先加载 Blob，加载完成后清理预加载状态
        handleLoadBlob(
          blobToLoad,
          nextPlayingSongPath,
          currentLoadRequestId.value,
          bpmValueToUse
        ).finally(() => {
          // 清理预加载状态 (放在 finally 确保执行)
          preloadedBlob.value = null
          preloadedSongFilePath.value = null
          isPreloading.value = false // 确保 isPreloading 也重置
          isPreloadReady.value = false
        })
      } else {
        // 未命中预加载 或 列表已空
        // 清理预加载状态
        preloadedBlob.value = null
        preloadedSongFilePath.value = null
        isPreloading.value = false
        isPreloadReady.value = false

        if (nextPlayingSong) {
          // 列表未空，但未命中预加载，请求加载
          isInternalSongChange.value = true
          runtime.playingData.playingSong = nextPlayingSong
          requestLoadSong(nextPlayingSong.filePath)
        } else {
          // 列表已空
          isInternalSongChange.value = true
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = '' // 清空播放列表 UUID
          waveformShow.value = false // 确保波形图隐藏
        }
      }

      // 执行删除操作（移动到回收站或彻底删除）
      const deletePromise = permanently
        ? window.electron.ipcRenderer.invoke('permanentlyDelSongs', [filePathToDelete])
        : window.electron.ipcRenderer.send('delSongs', [filePathToDelete], getCurrentTimeDirName())
      await Promise.resolve(deletePromise) // 等待删除操作完成

      await nextTick() // 等待 DOM 更新
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
      cancelPreloadTimer('handleMoveSong start')
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

      // 从当前播放列表中移除歌曲
      currentList.splice(currentIndex, 1)

      // 确定下一首要播放的歌曲
      let nextPlayingSong: ISongInfo | null = null
      let nextPlayingSongPath: string | null = null
      if (currentList.length > 0) {
        const nextIndex = Math.min(currentIndex, currentList.length - 1)
        nextPlayingSong = currentList[nextIndex]
        nextPlayingSongPath = nextPlayingSong?.filePath ?? null
      } else {
        // 列表为空
      }

      // 先执行移动操作，因为这可能会影响状态或触发其他事件
      await window.electron.ipcRenderer.invoke('moveSongsToDir', [filePathToMove], targetDirPath)

      // 如果移动的目标列表是当前歌曲区域显示的列表，则需要刷新歌曲区域
      if (targetListUuid === runtime.songsArea.songListUUID) {
        const currentSongsAreaUUID = runtime.songsArea.songListUUID
        runtime.songsArea.songListUUID = '' // 先设置为空
        await nextTick() // 等待DOM更新或其他异步操作
        runtime.songsArea.songListUUID = currentSongsAreaUUID // 再设置回来，触发更新
      }
      await nextTick() // 等待可能的其他更新

      // 现在检查预加载并确定如何加载下一首
      if (
        nextPlayingSongPath &&
        isPreloadReady.value &&
        preloadedSongFilePath.value === nextPlayingSongPath &&
        preloadedBlob.value
      ) {
        // 命中预加载
        const blobToLoad = preloadedBlob.value
        const bpmValueToUse = preloadedBpm.value
        isInternalSongChange.value = true
        runtime.playingData.playingSong = nextPlayingSong

        handleLoadBlob(
          blobToLoad,
          nextPlayingSongPath,
          currentLoadRequestId.value,
          bpmValueToUse
        ).finally(() => {
          preloadedBlob.value = null
          preloadedSongFilePath.value = null
          isPreloading.value = false
          isPreloadReady.value = false
          isFileOperationInProgress.value = false // 操作完成
        })
      } else {
        // 未命中预加载 或 列表已空
        preloadedBlob.value = null
        preloadedSongFilePath.value = null
        isPreloading.value = false
        isPreloadReady.value = false

        if (nextPlayingSong) {
          // 列表未空，但未命中预加载，请求加载
          isInternalSongChange.value = true
          runtime.playingData.playingSong = nextPlayingSong
          requestLoadSong(nextPlayingSong.filePath)
          isFileOperationInProgress.value = false // 操作完成
        } else {
          // 列表已空
          isInternalSongChange.value = true
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = '' // 清空播放列表 UUID
          isFileOperationInProgress.value = false // 操作完成
        }
      }
    } catch (error) {
      console.error(`[moveSong] 移动歌曲过程中发生错误 (${filePathToMove}):`, error)
      // 出错时也应该重置标志
      ignoreNextEmptyError.value = false
      isFileOperationInProgress.value = false // 允许后续操作
    }
  }

  const exportTrack = async () => {
    cancelPreloadTimer('exportTrack start') // 取消预加载
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

            // 清理预加载
            clearReadyPreloadState()
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
