import { ref, nextTick, type Ref } from 'vue'
import { type ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import exportDialog from '@renderer/components/exportDialog'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import { WebAudioPlayer } from './webAudioPlayer'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import {
  resolveLibraryTransferActionModeForPlayback,
  type LibraryTransferActionMode
} from '@renderer/utils/libraryTransfer'

type DeleteSummary = {
  total?: number
  success?: number
  failed?: number
  removedPaths?: string[]
}

type OptimisticRestoreItem = {
  song: ISongInfo
  index: number
}

// 定义 usePlayerControls 的参数类型
interface UsePlayerControlsOptions {
  audioPlayer: Ref<WebAudioPlayer | null>
  runtime: ReturnType<typeof useRuntimeStore>
  bpm: Ref<number | string>
  waveformShow: Ref<boolean>
  selectSongListDialogShow: Ref<boolean>
  selectSongListDialogLibraryName: Ref<string>
  selectSongListDialogActionMode: Ref<LibraryTransferActionMode>
  isInternalSongChange: Ref<boolean>
  requestLoadSong: (filePath: string) => void
  ignoreNextEmptyError: Ref<boolean>
}

export function usePlayerControlsLogic({
  audioPlayer,
  runtime,
  bpm,
  waveformShow,
  selectSongListDialogShow,
  selectSongListDialogLibraryName,
  selectSongListDialogActionMode,
  isInternalSongChange,
  requestLoadSong,
  ignoreNextEmptyError
}: UsePlayerControlsOptions) {
  // 调试日志已清理
  const isFileOperationInProgress = ref(false)
  const songToMoveRef = ref<{
    song: ISongInfo
    sourceListUuid: string
    actionMode: LibraryTransferActionMode
  } | null>(null)
  const normalizePath = (p: string | undefined | null) =>
    (p || '').replace(/\//g, '\\').toLowerCase()
  const isReadOnlyPlaybackSource = () =>
    isRekordboxExternalPlaybackSource(
      runtime.playingData.playingSongListUUID,
      runtime.playingData.playingSong
    )
  const buildSongSnapshot = (filePath: string, song: ISongInfo) => {
    const baseName =
      String(filePath || '')
        .split(/[/\\]/)
        .pop() || ''
    const parts = baseName.split('.')
    const ext = parts.length > 1 ? parts.pop() || '' : ''
    const fileFormat = ext ? ext.toUpperCase() : ''
    return {
      filePath,
      fileName: song?.fileName || baseName,
      fileFormat: song?.fileFormat || fileFormat,
      cover: null,
      title: song?.title ?? baseName,
      artist: song?.artist,
      album: song?.album,
      duration: song?.duration ?? '',
      genre: song?.genre,
      label: song?.label,
      bitrate: song?.bitrate,
      container: song?.container,
      key: song?.key,
      originalKey: song?.key,
      bpm: song?.bpm,
      originalBpm: song?.bpm,
      firstBeatMs: song?.firstBeatMs,
      barBeatOffset: song?.barBeatOffset,
      hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
      memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
    }
  }
  const showDeleteSummaryIfNeeded = async (
    summary: {
      total?: number
      success?: number
      failed?: number
    },
    options?: {
      restoredFailed?: boolean
    }
  ) => {
    const total = Number(summary?.total || 0)
    const success = Number(summary?.success || 0)
    const failed = Number(summary?.failed || 0)
    if (total <= 1 && failed === 0) return
    const content: string[] = []
    content.push(t('recycleBin.deleteSummarySuccess', { count: success }))
    if (failed > 0) {
      content.push(t('recycleBin.deleteSummaryFailed', { count: failed }))
      if (options?.restoredFailed) {
        content.push(t('recycleBin.deleteSummaryRestoredFailed', { count: failed }))
      }
    }
    await confirm({
      title: t('recycleBin.deleteSummaryTitle'),
      content,
      confirmShow: false
    })
  }
  const buildSongsAreaOptimisticRestoreItems = (
    listUUID: string,
    filePaths: string[]
  ): OptimisticRestoreItem[] => {
    if (!listUUID || runtime.songsArea.songListUUID !== listUUID) return []
    const pathSet = new Set(filePaths.map((item) => normalizePath(item)))
    return runtime.songsArea.songInfoArr
      .map((item, index) => ({ song: { ...item }, index }))
      .filter((item) => pathSet.has(normalizePath(item.song.filePath)))
  }
  const resolvePlaybackAfterRemovingSong = (filePath: string) => {
    const currentList = [...runtime.playingData.playingSongListData]
    const currentIndex = currentList.findIndex((song) => song.filePath === filePath)
    if (currentIndex === -1) {
      return {
        nextList: currentList,
        nextSong: null as ISongInfo | null
      }
    }
    const nextList = currentList.filter((_, index) => index !== currentIndex)
    const nextSong =
      nextList.length > 0 ? nextList[Math.min(currentIndex, nextList.length - 1)] || null : null
    return {
      nextList,
      nextSong
    }
  }
  const restorePlaybackAfterDeleteFailure = (payload: {
    listUUID: string
    listData: ISongInfo[]
    song: ISongInfo | null
  }) => {
    if (!payload.song?.filePath) {
      runtime.playingData.playingSongListUUID = payload.listUUID
      runtime.playingData.playingSongListData = payload.listData
      runtime.playingData.playingSong = null
      return
    }
    isInternalSongChange.value = true
    runtime.playingData.playingSongListUUID = payload.listUUID
    runtime.playingData.playingSongListData = payload.listData
    runtime.playingData.playingSong = payload.song
    requestLoadSong(payload.song.filePath)
  }
  const clearPlayerStateForDelete = () => {
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
    runtime.playerReady = false
    runtime.isSwitchingSong = false
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) {
        audioPlayer.value.pause()
      }
      ignoreNextEmptyError.value = true
      audioPlayer.value.empty()
    }
    waveformShow.value = false
    bpm.value = ''
    isInternalSongChange.value = true
    runtime.playingData.playingSong = null
  }
  const finalizeDestroyedPlayerState = () => {
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
  }
  // 取消长按抑制方案，改由 playerReady 门槛保障

  const play = () => {
    if (!audioPlayer.value) return

    try {
      if (!audioPlayer.value.hasSource()) {
        return
      }
      audioPlayer.value.play()
    } catch (error) {
      // 播放出错时静默失败
    }
  }

  const pause = () => {
    audioPlayer.value?.pause()
  }

  const togglePlayPause = () => {
    if (!audioPlayer.value) return

    try {
      if (audioPlayer.value.isPlaying()) {
        pause()
      } else {
        play()
      }
    } catch (error) {
      audioPlayer.value.pause()
    }
  }

  const fastForward = () => {
    const player = audioPlayer.value
    if (!player) return

    if (runtime.isSwitchingSong || !runtime.playerReady) {
      return
    }

    const duration = player.getDuration()
    if (!duration || Number.isNaN(duration)) return

    const skipAmount = runtime.setting.fastForwardTime

    let hasNextSong = false
    if (runtime.playingData.playingSong && runtime.playingData.playingSongListData?.length) {
      const currentIndex = runtime.playingData.playingSongListData.findIndex(
        (item) => item.filePath === runtime.playingData.playingSong?.filePath
      )
      hasNextSong =
        currentIndex !== -1 && currentIndex < runtime.playingData.playingSongListData.length - 1
    }

    const endTime = duration
    const currentTime = player.getCurrentTime()
    const targetTime = currentTime + skipAmount

    const epsilon = 0.01

    if (targetTime >= endTime - epsilon) {
      if (runtime.setting.autoPlayNextSong && hasNextSong) {
        runtime.playerReady = false
        runtime.isSwitchingSong = true
        nextSong()
      } else {
        player.seek(endTime, true)
        player.pause()
      }
      return
    }

    player.skip(skipAmount, true)
  }

  const fastBackward = () => {
    audioPlayer.value?.skip(runtime.setting.fastBackwardTime, true)
  }

  const nextSong = () => {
    // 切歌开始，标记未就绪，阻止快进再次触发
    runtime.playerReady = false
    runtime.isSwitchingSong = true
    if (!runtime.playingData.playingSong) return
    const currentIndex = runtime.playingData.playingSongListData.findIndex(
      (item) => item.filePath === runtime.playingData.playingSong?.filePath
    )
    if (currentIndex === -1 || currentIndex >= runtime.playingData.playingSongListData.length - 1) {
      return
    }
    // 向后寻找下一个可播放曲目
    let nextIndex = currentIndex + 1
    let nextSongData = runtime.playingData.playingSongListData[nextIndex]
    if (!nextSongData) return
    const nextSongFilePath = nextSongData.filePath
    // 每次切换歌曲时，强制清空播放器实例
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) {
        audioPlayer.value.pause()
      }
      ignoreNextEmptyError.value = true
      audioPlayer.value.stop()
    }

    // 重要：在开始加载前先更新UI状态
    isInternalSongChange.value = true // 标记内部切换
    runtime.playingData.playingSong = nextSongData
    requestLoadSong(nextSongFilePath)
  }

  const previousSong = () => {
    // 切歌开始，标记未就绪，阻止快进再次触发
    runtime.playerReady = false
    runtime.isSwitchingSong = true
    if (!runtime.playingData.playingSong) return

    const currentIndex = runtime.playingData.playingSongListData.findIndex(
      (item) => item.filePath === runtime.playingData.playingSong?.filePath
    )
    if (currentIndex <= 0) {
      // 如果是第一首，或者找不到，则不执行任何操作
      return
    }

    // 向前寻找上一个可播放曲目
    let prevIndex = currentIndex - 1
    let prevCandidate: ISongInfo | null = null
    if (prevIndex >= 0) {
      prevCandidate = runtime.playingData.playingSongListData[prevIndex]
    }
    if (!prevCandidate) return

    const prevSongFilePath = prevCandidate.filePath
    // 每次切换歌曲时，强制清空播放器实例
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) {
        audioPlayer.value.pause()
      }
      ignoreNextEmptyError.value = true
      audioPlayer.value.stop()
    }
    // 设置内部切换并请求加载
    isInternalSongChange.value = true // 标记内部切换
    runtime.playingData.playingSong = prevCandidate
    requestLoadSong(prevSongFilePath)
  }

  const delSong = async () => {
    if (isFileOperationInProgress.value || !runtime.playingData.playingSong) {
      return
    }
    if (isReadOnlyPlaybackSource()) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('tracks.readOnlySourceDeleteNotAllowed')],
        confirmShow: false
      })
      return
    }

    try {
      isFileOperationInProgress.value = true
      const filePathToDelete = runtime.playingData.playingSong.filePath
      const currentSongListUUID = runtime.playingData.playingSongListUUID
      const currentPlayingSongSnapshot = runtime.playingData.playingSong
        ? { ...runtime.playingData.playingSong }
        : null
      const currentPlayingListSnapshot = [...runtime.playingData.playingSongListData]
      const playbackAfterDelete = resolvePlaybackAfterRemovingSong(filePathToDelete)
      let shouldFinalizeDestroyedPlayerState = false
      let shouldRestorePlaybackAfterFailure = false

      try {
        // 检查是否在回收站
        const isInRecycleBin = currentSongListUUID === RECYCLE_BIN_UUID
        const isExternalView = currentSongListUUID === EXTERNAL_PLAYLIST_UUID

        let performDelete = false
        let permanently = false

        if (isInRecycleBin) {
          // 在回收站，询问是否彻底删除
          const res = await confirm({
            title: t('common.delete'),
            content: [t('tracks.confirmDeletePlaying'), t('tracks.deleteHint')]
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
          return // 用户取消操作
        }

        const optimisticRestoreItems = buildSongsAreaOptimisticRestoreItems(currentSongListUUID, [
          filePathToDelete
        ])
        clearPlayerStateForDelete()
        shouldRestorePlaybackAfterFailure = true
        emitter.emit('songsArea/optimistic-remove', {
          listUUID: currentSongListUUID,
          paths: [filePathToDelete]
        })

        // 执行删除操作（移动到回收站或彻底删除）
        let removedPathsForEvent = [filePathToDelete]
        try {
          let deleteSummary: DeleteSummary
          if (permanently) {
            const summary = await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
              filePathToDelete
            ])
            deleteSummary = {
              total: Number(summary?.total || 0),
              success: Number(summary?.success || 0),
              failed: Number(summary?.failed || 0),
              removedPaths: Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
            }
          } else {
            const payload = isExternalView
              ? { filePaths: [filePathToDelete], sourceType: 'external' }
              : (() => {
                  const songListPath = libraryUtils.findDirPathByUuid(currentSongListUUID)
                  return songListPath
                    ? { filePaths: [filePathToDelete], songListPath }
                    : [filePathToDelete]
                })()
            const summary = await window.electron.ipcRenderer.invoke('delSongsAwaitable', payload)
            deleteSummary = {
              total: Number(summary?.total || 0),
              success: Number(summary?.success || 0),
              failed: Number(summary?.failed || 0),
              removedPaths: Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
            }
          }
          removedPathsForEvent = deleteSummary.removedPaths || []
          const removedNormalizedSet = new Set(
            removedPathsForEvent.map((item) => normalizePath(item))
          )
          const failedRestoreItems =
            Number(deleteSummary.failed || 0) > 0
              ? optimisticRestoreItems.filter(
                  (item) => !removedNormalizedSet.has(normalizePath(item.song.filePath))
                )
              : []
          if (failedRestoreItems.length > 0) {
            emitter.emit('songsArea/optimistic-restore', {
              listUUID: currentSongListUUID,
              items: failedRestoreItems
            })
          }
          if (Number(deleteSummary.failed || 0) > 0) {
            await showDeleteSummaryIfNeeded(deleteSummary, {
              restoredFailed: failedRestoreItems.length > 0
            })
          }
        } catch {
          if (optimisticRestoreItems.length > 0) {
            emitter.emit('songsArea/optimistic-restore', {
              listUUID: currentSongListUUID,
              items: optimisticRestoreItems
            })
          }
          await showDeleteSummaryIfNeeded(
            {
              total: 1,
              success: 0,
              failed: 1
            },
            { restoredFailed: optimisticRestoreItems.length > 0 }
          )
          return
        }

        if (playbackAfterDelete.nextSong?.filePath) {
          isInternalSongChange.value = true
          runtime.playingData.playingSongListUUID = currentSongListUUID
          runtime.playingData.playingSongListData = playbackAfterDelete.nextList
          runtime.playingData.playingSong = playbackAfterDelete.nextSong
          requestLoadSong(playbackAfterDelete.nextSong.filePath)
          shouldRestorePlaybackAfterFailure = false
        } else {
          shouldFinalizeDestroyedPlayerState = true
          shouldRestorePlaybackAfterFailure = false
        }

        // 广播删除，保证当前 songsArea 若显示同一歌单可同步移除
        const listUuidAtDeleteStart = currentSongListUUID
        if (removedPathsForEvent.length > 0) {
          emitter.emit('songsRemoved', {
            listUUID: listUuidAtDeleteStart,
            paths: removedPathsForEvent
          })
        }
        if (listUuidAtDeleteStart) {
          emitter.emit('playlistContentChanged', { uuids: [listUuidAtDeleteStart] })
        }

        await nextTick() // 等待 DOM 更新
      } catch (error) {
        console.error(`[delSong] 删除歌曲过程中发生错误 (${filePathToDelete}):`, error)
        ignoreNextEmptyError.value = false
      } finally {
        if (shouldRestorePlaybackAfterFailure) {
          restorePlaybackAfterDeleteFailure({
            listUUID: currentSongListUUID,
            listData: currentPlayingListSnapshot,
            song: currentPlayingSongSnapshot
          })
          shouldRestorePlaybackAfterFailure = false
        }
        if (shouldFinalizeDestroyedPlayerState) {
          finalizeDestroyedPlayerState()
        }
      }
    } finally {
      isFileOperationInProgress.value = false
    }
  }

  const openSongMoveDialog = (
    libraryName: 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary',
    song?: ISongInfo
  ) => {
    const targetSong = song || runtime.playingData.playingSong
    if (!targetSong) return
    const sourceListUuid = String(runtime.playingData.playingSongListUUID || '')
    songToMoveRef.value = {
      song: targetSong,
      sourceListUuid,
      actionMode: resolveLibraryTransferActionModeForPlayback(sourceListUuid, targetSong)
    }
    selectSongListDialogActionMode.value = songToMoveRef.value.actionMode
    selectSongListDialogLibraryName.value = libraryName
    selectSongListDialogShow.value = true
  }

  const moveToListLibrary = (song?: ISongInfo) => {
    openSongMoveDialog('FilterLibrary', song)
  }

  const moveToLikeLibrary = (song?: ISongInfo) => {
    openSongMoveDialog('CuratedLibrary', song)
  }

  const moveToMixtapeLibrary = (song?: ISongInfo) => {
    openSongMoveDialog('MixtapeLibrary', song)
  }

  // 这个函数在 usePlayerControlsLogic 内部使用，不需要导出
  const handleMoveSong = async (targetListUuid: string) => {
    if (isFileOperationInProgress.value) {
      return
    }

    // 使用存储的歌曲信息或当前播放的歌曲
    const moveContext =
      songToMoveRef.value && songToMoveRef.value.song
        ? songToMoveRef.value
        : runtime.playingData.playingSong
          ? {
              song: runtime.playingData.playingSong,
              sourceListUuid: String(runtime.playingData.playingSongListUUID || ''),
              actionMode: resolveLibraryTransferActionModeForPlayback(
                runtime.playingData.playingSongListUUID,
                runtime.playingData.playingSong
              )
            }
          : null
    if (!moveContext) {
      return
    }
    const songToMove = moveContext.song

    const sourceActionMode = moveContext.actionMode
    const readOnlySource = sourceActionMode === 'copy'
    const sourceRequiresVaultCopy = isRekordboxExternalPlaybackSource(
      moveContext.sourceListUuid,
      songToMove
    )
    const targetNode = libraryUtils.getLibraryTreeByUUID(targetListUuid)
    const isMixtapeTarget = targetNode?.type === 'mixtapeList'

    if (!readOnlySource && targetListUuid === moveContext.sourceListUuid) {
      // 移动到当前列表，无需操作
      // 重置存储的歌曲信息
      songToMoveRef.value = null
      return
    }

    isFileOperationInProgress.value = true
    const filePathToMove = songToMove.filePath
    const sourceListUuid = moveContext.sourceListUuid
    const targetDirPath = isMixtapeTarget ? '' : libraryUtils.findDirPathByUuid(targetListUuid)

    // 重置存储的歌曲信息
    songToMoveRef.value = null

    if (!isMixtapeTarget && !targetDirPath) {
      console.error(
        `[usePlayerControlsLogic] handleMoveSong: 未找到目标目录路径: ${targetListUuid}`
      )
      isFileOperationInProgress.value = false
      return
    }

    try {
      selectSongListDialogShow.value = false // 关闭对话框

      if (readOnlySource) {
        if (isMixtapeTarget) {
          let mixtapeTargetPath = filePathToMove
          if (sourceRequiresVaultCopy) {
            const copiedTracks = (await window.electron.ipcRenderer.invoke(
              'mixtape:copy-files-to-vault',
              {
                filePaths: [filePathToMove]
              }
            )) as Array<{ sourcePath: string; targetPath: string }>
            mixtapeTargetPath = String(copiedTracks[0]?.targetPath || '').trim()
          }
          const copiedPath = mixtapeTargetPath
          if (!copiedPath) {
            throw new Error('MIXTAPE_COPY_TO_VAULT_FAILED')
          }
          await window.electron.ipcRenderer.invoke('mixtape:append', {
            playlistId: targetListUuid,
            items: [
              {
                filePath: copiedPath,
                originPathSnapshot:
                  runtime.pioneerDeviceLibrary.selectedSourceName || 'Pioneer USB',
                info: buildSongSnapshot(copiedPath, songToMove)
              }
            ]
          })
          emitter.emit('playlistContentChanged', { uuids: [targetListUuid] })
          emitter.emit('songsArea/clipboardHint', {
            message: t('mixtape.addedToMixtape', { count: 1 })
          })
          isFileOperationInProgress.value = false
          return
        }

        const copiedPaths = (await window.electron.ipcRenderer.invoke(
          'moveSongsToDir',
          [filePathToMove],
          targetDirPath,
          {
            mode: 'copy',
            curatedArtistNames: [songToMove?.artist || '']
          }
        )) as string[]
        await copySongCueDefinitionsToTargets([
          {
            targetFilePath: copiedPaths[0],
            sourceSong: songToMove
          }
        ])
        emitter.emit('playlistContentChanged', { uuids: [targetListUuid] })
        isFileOperationInProgress.value = false
        return
      }

      const currentList = runtime.playingData.playingSongListData
      const currentIndex = currentList.findIndex((song) => song.filePath === filePathToMove)

      if (currentIndex === -1) {
        console.error(
          `[usePlayerControlsLogic] handleMoveSong: 未找到要移动的歌曲: ${filePathToMove}`
        )
        isFileOperationInProgress.value = false
        return
      }

      // 停止播放并清空播放器
      if (audioPlayer.value) {
        if (audioPlayer.value.isPlaying()) {
          audioPlayer.value.pause()
        }
        ignoreNextEmptyError.value = true
        audioPlayer.value.empty()
      }
      waveformShow.value = false
      bpm.value = '' // 清空 BPM

      // 从当前播放列表中移除歌曲
      currentList.splice(currentIndex, 1)

      // 确定下一首要播放的歌曲
      let nextPlayingSong: ISongInfo | null = null
      if (currentList.length > 0) {
        const nextIndex = Math.min(currentIndex, currentList.length - 1)
        nextPlayingSong = currentList[nextIndex]
      }

      // 先执行移动操作，因为这可能会影响状态或触发其他事件
      const movedPaths = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        [filePathToMove],
        targetDirPath,
        {
          curatedArtistNames: [songToMove?.artist || '']
        }
      )) as string[]
      await copySongCueDefinitionsToTargets([
        {
          targetFilePath: movedPaths[0],
          sourceSong: songToMove
        }
      ])

      // 先切到下一首，再广播移除事件，避免全局 songsRemoved 监听把当前播放上下文误清空。
      if (nextPlayingSong) {
        isInternalSongChange.value = true
        runtime.playingData.playingSongListUUID = sourceListUuid
        runtime.playingData.playingSong = nextPlayingSong
        requestLoadSong(nextPlayingSong.filePath)
      } else {
        isInternalSongChange.value = true
        runtime.playingData.playingSong = null
        runtime.playingData.playingSongListUUID = '' // 清空播放列表 UUID
      }

      // 广播源/目标歌单变化
      emitter.emit('playlistContentChanged', {
        uuids: [sourceListUuid, targetListUuid].filter(Boolean)
      })

      // 广播删除（从源列表移除当前播放歌曲），确保 songsArea 能同步剔除并重建
      try {
        const normalizePath = (p: string | undefined | null) =>
          (p || '').replace(/\//g, '\\').toLowerCase()
        const normalizedPath = normalizePath(filePathToMove)
        emitter.emit('songsRemoved', {
          listUUID: sourceListUuid,
          paths: [normalizedPath]
        })
      } catch {}

      // 如果移动的目标列表是当前歌曲区域显示的列表，则需要刷新歌曲区域
      if (targetListUuid === runtime.songsArea.songListUUID) {
        const currentSongsAreaUUID = runtime.songsArea.songListUUID
        runtime.songsArea.songListUUID = '' // 先设置为空
        await nextTick() // 等待DOM更新或其他异步操作
        runtime.songsArea.songListUUID = currentSongsAreaUUID // 再设置回来，触发更新
      }
      await nextTick() // 等待可能的其他更新

      isFileOperationInProgress.value = false
    } catch (error) {
      console.error(
        `[usePlayerControlsLogic] handleMoveSong: 移动歌曲过程中发生错误 (${filePathToMove}):`,
        error
      )
      // 出错时也应该重置标志
      ignoreNextEmptyError.value = false
      isFileOperationInProgress.value = false // 允许后续操作
    }
  }

  const exportTrack = async () => {
    if (!runtime.playingData.playingSong) {
      console.error('无法导出，没有歌曲正在播放。')
      return
    }

    // 弹出导出对话框
    let result = await exportDialog({
      title: 'tracks.title',
      forceCopyOnly: isReadOnlyPlaybackSource()
    })
    if (result !== 'cancel') {
      let folderPathVal = result.folderPathVal
      let deleteSongsAfterExport = isReadOnlyPlaybackSource()
        ? false
        : result.deleteSongsAfterExport

      // 深拷贝当前播放歌曲信息，避免后续操作影响原始数据
      const songToExport = JSON.parse(JSON.stringify(runtime.playingData.playingSong))
      const filePath = songToExport.filePath
      const currentList = runtime.playingData.playingSongListData
      const currentIndex = currentList.findIndex((item) => item.filePath === filePath)
      const listUuidAtExportStart = runtime.playingData.playingSongListUUID

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
            audioPlayer.value?.stop()
            audioPlayer.value?.empty()
            waveformShow.value = false
            bpm.value = ''

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
            runtime.playingData.playingSongListUUID = listUuidAtExportStart
            runtime.playingData.playingSong = nextPlayingSong

            // 加载下一首歌或清空列表
            if (nextPlayingSong) {
              requestLoadSong(nextPlayingSong.filePath)
            } else {
              runtime.playingData.playingSongListUUID = ''
            }
          }
          emitter.emit('songsRemoved', { listUUID: listUuidAtExportStart, paths: [filePath] })
          emitter.emit('playlistContentChanged', { uuids: [listUuidAtExportStart] })
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
    moveToMixtapeLibrary,
    exportTrack,
    handleMoveSong // 暴露给父组件的 selectSongListDialogConfirm 使用
  }
}
