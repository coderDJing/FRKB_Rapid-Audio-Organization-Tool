import { ref, computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'

export interface DragSongData {
  songFilePaths: string[]
  sourceLibraryName: string
  sourceSongListUUID: string
  sourceMixtapeItemIds?: string[]
}

type StartDragSongsOptions = {
  songFilePaths?: string[]
  sourceMixtapeItemIds?: string[]
}

export function useDragSongs() {
  const runtime = useRuntimeStore()
  const isDragging = ref(false)
  const dragData = ref<DragSongData | null>(null)
  let dragCleanupTimer: ReturnType<typeof setTimeout> | null = null

  const clearDragCleanupTimer = () => {
    if (dragCleanupTimer) {
      clearTimeout(dragCleanupTimer)
      dragCleanupTimer = null
    }
  }
  const setRuntimeDragState = (
    filePaths: string[],
    sourceSongListUUID: string,
    sourceMixtapeItemIds: string[] = []
  ) => {
    runtime.songDragActive = true
    runtime.draggingSongFilePaths = [...filePaths]
    runtime.dragSourceSongListUUID = sourceSongListUUID
    runtime.dragSourceMixtapeItemIds = [...sourceMixtapeItemIds]
  }
  const clearRuntimeDragState = () => {
    runtime.songDragActive = false
    runtime.draggingSongFilePaths = []
    runtime.dragSourceSongListUUID = ''
    runtime.dragSourceMixtapeItemIds = []
  }
  const normalizeUniqueStrings = (values: unknown[]): string[] =>
    Array.from(
      new Set(
        values
          .filter((value) => typeof value === 'string')
          .map((value) => String(value).trim())
          .filter(Boolean)
      )
    )

  const resolveFileNameAndFormat = (filePath: string) => {
    const baseName =
      String(filePath || '')
        .split(/[/\\]/)
        .pop() || ''
    const parts = baseName.split('.')
    const ext = parts.length > 1 ? parts.pop() || '' : ''
    const fileFormat = ext ? ext.toUpperCase() : ''
    return { fileName: baseName, fileFormat }
  }

  const buildSongSnapshot = (filePath: string, song?: ISongInfo | null) => {
    const meta = resolveFileNameAndFormat(filePath)
    return {
      filePath,
      fileName: song?.fileName || meta.fileName,
      fileFormat: song?.fileFormat || meta.fileFormat,
      cover: null,
      title: song?.title ?? meta.fileName,
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
      originalBpm: song?.bpm
    }
  }

  /**
   * 开始拖拽歌曲
   * @param songOrSongs - 单个歌曲或歌曲数组
   * @param sourceLibraryName - 源库名称
   * @param sourceSongListUUID - 源歌单UUID
   */
  const startDragSongs = (
    songOrSongs: ISongInfo | ISongInfo[],
    sourceLibraryName: string,
    sourceSongListUUID: string,
    options?: StartDragSongsOptions
  ): string[] => {
    clearDragCleanupTimer()
    // 如果是单个歌曲且没有被选中，则只拖拽该歌曲
    // 如果是单个歌曲但已被选中，则拖拽所有选中的歌曲
    // 如果传入的是数组，则拖拽整个数组
    let songFilePaths: string[]
    const optionPaths = normalizeUniqueStrings(
      Array.isArray(options?.songFilePaths) ? options.songFilePaths : []
    )
    const sourceMixtapeItemIds = normalizeUniqueStrings(
      Array.isArray(options?.sourceMixtapeItemIds) ? options.sourceMixtapeItemIds : []
    )

    if (optionPaths.length > 0) {
      songFilePaths = optionPaths
    } else {
      if (Array.isArray(songOrSongs)) {
        songFilePaths = songOrSongs.map((song) => song.filePath)
      } else {
        const singleSong = songOrSongs
        const isSelected = runtime.songsArea.selectedSongFilePath.includes(singleSong.filePath)

        if (isSelected && runtime.songsArea.selectedSongFilePath.length > 0) {
          // 如果这首歌被选中且有其他选中的歌曲，拖拽所有选中的歌曲
          songFilePaths = [...runtime.songsArea.selectedSongFilePath]
        } else {
          // 否则只拖拽这首歌
          songFilePaths = [singleSong.filePath]
        }
      }
    }

    dragData.value = {
      songFilePaths,
      sourceLibraryName,
      sourceSongListUUID,
      sourceMixtapeItemIds
    }
    isDragging.value = true
    setRuntimeDragState(songFilePaths, sourceSongListUUID, sourceMixtapeItemIds)
    return songFilePaths
  }

  /**
   * 结束拖拽
   */
  const endDragSongs = () => {
    isDragging.value = false
    dragData.value = null
    clearRuntimeDragState()
    clearDragCleanupTimer()
  }

  const scheduleDragCleanup = (delayMs: number = 8000) => {
    clearDragCleanupTimer()
    dragCleanupTimer = setTimeout(() => {
      endDragSongs()
    }, delayMs)
  }

  /**
   * 处理拖拽到歌单的逻辑
   * @param targetSongListUUID - 目标歌单UUID
   * @param targetLibraryName - 目标库名称
   * @returns 被移动的歌曲文件路径数组
   */
  const handleDropToSongList = async (targetSongListUUID: string, _targetLibraryName: string) => {
    try {
      // 优先使用拖拽开始时快照，避免拖拽过程中选中态变化导致错移
      const selectedSongFilePaths =
        dragData.value?.songFilePaths?.length && Array.isArray(dragData.value.songFilePaths)
          ? [...dragData.value.songFilePaths]
          : [...runtime.songsArea.selectedSongFilePath]
      const sourceMixtapeItemIds = normalizeUniqueStrings(
        Array.isArray(dragData.value?.sourceMixtapeItemIds) &&
          dragData.value.sourceMixtapeItemIds.length > 0
          ? dragData.value.sourceMixtapeItemIds
          : Array.isArray(runtime.dragSourceMixtapeItemIds)
            ? runtime.dragSourceMixtapeItemIds
            : []
      )
      const sourceSongListUUID =
        dragData.value?.sourceSongListUUID ||
        runtime.dragSourceSongListUUID ||
        runtime.songsArea.songListUUID

      if (!selectedSongFilePaths.length || !sourceSongListUUID) {
        return []
      }
      if (targetSongListUUID === sourceSongListUUID) {
        return []
      }

      const targetNode = libraryUtils.getLibraryTreeByUUID(targetSongListUUID)
      const sourceNode = libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)
      const isMixtapeTarget = targetNode?.type === 'mixtapeList'

      if (isMixtapeTarget) {
        if (!sourceNode || (sourceNode.type !== 'songList' && sourceNode.type !== 'mixtapeList')) {
          return []
        }
        const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(sourceSongListUUID)
        const songMap = new Map(runtime.songsArea.songInfoArr.map((song) => [song.filePath, song]))
        const mixtapeSongMap = new Map(
          runtime.songsArea.songInfoArr
            .filter(
              (song) => typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.length > 0
            )
            .map((song) => [song.mixtapeItemId as string, song])
        )
        const itemsFromMixtapeIds = sourceMixtapeItemIds
          .map((itemId) => {
            const song = mixtapeSongMap.get(itemId)
            const filePath = song?.filePath || ''
            if (!song || !filePath) return null
            return {
              filePath,
              originPlaylistUuid: sourceSongListUUID,
              originPathSnapshot,
              info: buildSongSnapshot(filePath, song),
              sourcePlaylistId: sourceSongListUUID,
              sourceItemId: itemId
            }
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
        const itemsFromMixtapePaths = normalizeUniqueStrings(selectedSongFilePaths)
          .map((filePath) => {
            const song = songMap.get(filePath)
            if (!song || !song.filePath) return null
            return {
              filePath: song.filePath,
              originPlaylistUuid: sourceSongListUUID,
              originPathSnapshot,
              info: buildSongSnapshot(song.filePath, song),
              sourcePlaylistId: sourceSongListUUID,
              sourceItemId:
                typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.trim()
                  ? song.mixtapeItemId.trim()
                  : undefined
            }
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
        const items =
          sourceNode.type === 'mixtapeList'
            ? itemsFromMixtapeIds.length > 0
              ? itemsFromMixtapeIds
              : itemsFromMixtapePaths
            : normalizeUniqueStrings(selectedSongFilePaths).map((filePath) => ({
                filePath,
                originPlaylistUuid: sourceSongListUUID,
                originPathSnapshot,
                info: buildSongSnapshot(filePath, songMap.get(filePath))
              }))
        if (items.length === 0) {
          return []
        }
        await window.electron.ipcRenderer.invoke('mixtape:append', {
          playlistId: targetSongListUUID,
          items
        })
        try {
          emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        } catch {}
        // Mixtape 自动录制歌单目标始终为复制，不回传“移动”结果
        return []
      }

      if (sourceNode?.type === 'mixtapeList') {
        return []
      }

      // 获取目标路径，确保是纯字符串
      const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)

      if (!targetDirPath) {
        return []
      }

      // 调用移动歌曲的 IPC，确保所有参数都是可序列化的
      await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        selectedSongFilePaths,
        targetDirPath
      )

      // 广播：源/目标歌单内容发生变化（用于刷新数量）
      try {
        const affected = [sourceSongListUUID, targetSongListUUID].filter(Boolean)
        emitter.emit('playlistContentChanged', { uuids: affected })
      } catch {}

      // 广播：源歌单移除这些歌曲，确保当前视图（若显示源歌单或其筛选结果）能及时剔除并重建
      try {
        const normalizePath = (p: string | undefined | null) =>
          (p || '').replace(/\//g, '\\').toLowerCase()
        const normalized = selectedSongFilePaths.map((p) => normalizePath(p))
        emitter.emit('songsRemoved', {
          listUUID: sourceSongListUUID,
          paths: normalized
        })
      } catch {}

      return selectedSongFilePaths
    } finally {
      endDragSongs()
    }
  }

  const draggedSongCount = computed(() => {
    return dragData.value?.songFilePaths.length || 0
  })

  return {
    isDragging,
    dragData,
    draggedSongCount,
    startDragSongs,
    endDragSongs,
    scheduleDragCleanup,
    handleDropToSongList
  }
}
