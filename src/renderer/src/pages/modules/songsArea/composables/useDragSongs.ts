import { ref, computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'

export interface DragSongData {
  songFilePaths: string[]
  sourceLibraryName: string
  sourceSongListUUID: string
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
  const setRuntimeDragState = (filePaths: string[], sourceSongListUUID: string) => {
    runtime.songDragActive = true
    runtime.draggingSongFilePaths = [...filePaths]
    runtime.dragSourceSongListUUID = sourceSongListUUID
  }
  const clearRuntimeDragState = () => {
    runtime.songDragActive = false
    runtime.draggingSongFilePaths = []
    runtime.dragSourceSongListUUID = ''
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
    sourceSongListUUID: string
  ): string[] => {
    clearDragCleanupTimer()
    // 如果是单个歌曲且没有被选中，则只拖拽该歌曲
    // 如果是单个歌曲但已被选中，则拖拽所有选中的歌曲
    // 如果传入的是数组，则拖拽整个数组
    let songFilePaths: string[]

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

    dragData.value = {
      songFilePaths,
      sourceLibraryName,
      sourceSongListUUID
    }
    isDragging.value = true
    setRuntimeDragState(songFilePaths, sourceSongListUUID)
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
  const handleDropToSongList = async (targetSongListUUID: string, targetLibraryName: string) => {
    try {
      // 直接从 runtime store 获取当前选中的歌曲
      const selectedSongFilePaths = [...runtime.songsArea.selectedSongFilePath] // 创建副本避免响应式对象
      const sourceSongListUUID = runtime.dragSourceSongListUUID || runtime.songsArea.songListUUID

      if (!selectedSongFilePaths.length || !sourceSongListUUID) {
        return []
      }

      // 如果目标歌单和源歌单相同，不做任何操作
      if (targetSongListUUID === sourceSongListUUID) {
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
