import { reactive, ref, watch, type Ref } from 'vue'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'
import libraryUtils from '@renderer/utils/libraryUtils'

interface UseLibraryDragAndDropOptions {
  runtime: any
  dirDataRef: Ref<any | null>
  fatherDirDataRef: Ref<any | null>
  deleteDir: () => Promise<void>
  props: { uuid: string }
  handleDropToSongList: (targetUuid: string, sourceUuid: string) => Promise<string[]>
  emitter: { emit: (event: string, payload?: any) => void }
}

export function useLibraryDragAndDrop({
  runtime,
  dirDataRef,
  fatherDirDataRef,
  deleteDir,
  props,
  handleDropToSongList,
  emitter
}: UseLibraryDragAndDropOptions) {
  const emitDevLog = (message: string, data?: Record<string, unknown>) => {
    try {
      window.electron.ipcRenderer.send('devLog', {
        scope: 'library-item-dnd',
        message,
        data: data || {}
      })
    } catch {}
  }
  const getDirData = () => dirDataRef.value
  const getFatherDirData = () => fatherDirDataRef.value

  const dragApproach = ref('')
  const dragState = reactive<DragState>({
    dragApproach: ''
  })

  watch(
    () => dragState.dragApproach,
    (newVal) => {
      dragApproach.value = newVal
    }
  )

  const dragstart = async (event: DragEvent) => {
    const shouldDelete = await handleDragStart(event, props.uuid)
    if (shouldDelete) {
      runtime.dragItemData = null
      return
    }
    event.target?.addEventListener(
      'dragend',
      () => {
        runtime.dragItemData = null
      },
      { once: true }
    )
  }

  const isPlaylistInRecycleBin = () => {
    const recycleBin = runtime.libraryTree.children?.find(
      (item: any) => item.dirName === 'RecycleBin'
    )
    return recycleBin?.children?.some((child: any) => child.uuid === props.uuid)
  }

  const isInternalSongDrag = (e: DragEvent) => {
    if (runtime.dragItemData) return false
    if (e.dataTransfer?.types?.includes('application/x-song-drag')) return true
    return runtime.songDragActive && runtime.draggingSongFilePaths.length > 0
  }

  const suppressNextLibraryClick = (delayMs: number = 450) => {
    runtime.songDragSuppressClickUntilMs = Date.now() + delayMs
  }

  const isMixtapeSourceSongDrag = () => {
    if (
      Array.isArray(runtime.dragSourceMixtapeItemIds) &&
      runtime.dragSourceMixtapeItemIds.length > 0
    ) {
      return true
    }
    const sourceSongListUUID = runtime.dragSourceSongListUUID
    if (!sourceSongListUUID) return false
    return libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)?.type === 'mixtapeList'
  }

  const handleSongDragGuard = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return true
    const isSongDrag = isInternalSongDrag(e)
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return true
    }
    if (isSongDrag && dirData.type === 'songList' && isMixtapeSourceSongDrag()) {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      emitDevLog('library drop blocked: mixtape source to normal list', {
        sourceSongListUUID: runtime.dragSourceSongListUUID,
        targetSongListUUID: props.uuid
      })
      return true
    }
    if (isSongDrag && (dirData.type === 'songList' || dirData.type === 'mixtapeList')) {
      if (isPlaylistInRecycleBin()) {
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'none'
        }
        return true
      }
    }
    return false
  }

  const dragover = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (isInternalDrag && dirData.type === 'songList' && isMixtapeSourceSongDrag()) {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      dragState.dragApproach = ''
      return
    }
    if (isInternalDrag && (dirData.type === 'songList' || dirData.type === 'mixtapeList')) {
      if (isPlaylistInRecycleBin()) {
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'none'
        }
        return
      }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = dirData.type === 'mixtapeList' ? 'copy' : 'move'
      }
      dragState.dragApproach = 'center'
      return
    }
    handleDragOver(e, dirData, dragState)
  }

  const dragenter = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return
    if (handleSongDragGuard(e)) {
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (
      isInternalDrag &&
      (dirData.type === 'songList' || dirData.type === 'mixtapeList') &&
      !isPlaylistInRecycleBin()
    ) {
      e.preventDefault()
      dragState.dragApproach = 'center'
      return
    }
    handleDragEnter(e, dirData, dragState)
  }

  const dragleave = () => {
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      return
    }
    handleDragLeave(dragState)
  }

  const drop = async (e: DragEvent) => {
    const dirData = getDirData()
    const fatherDirData = getFatherDirData()
    if (!dirData || !fatherDirData) {
      dragState.dragApproach = ''
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (handleSongDragGuard(e)) {
      dragState.dragApproach = ''
      if (isInternalDrag) suppressNextLibraryClick()
      return
    }
    emitDevLog('library drop hit', {
      targetUuid: props.uuid,
      targetType: dirData.type,
      isInternalDrag,
      runtimeSongDragActive: runtime.songDragActive,
      runtimeDraggingPathCount: Array.isArray(runtime.draggingSongFilePaths)
        ? runtime.draggingSongFilePaths.length
        : 0,
      hasSongDragMime: !!e.dataTransfer?.types?.includes('application/x-song-drag')
    })
    if (isInternalDrag && (dirData.type === 'songList' || dirData.type === 'mixtapeList')) {
      if (isPlaylistInRecycleBin()) {
        dragState.dragApproach = ''
        suppressNextLibraryClick()
        return
      }
      e.preventDefault()
      const movedSongPaths = await handleDropToSongList(props.uuid, runtime.libraryAreaSelected)
      emitDevLog('library drop handled by songs dnd', {
        targetUuid: props.uuid,
        targetType: dirData.type,
        movedCount: movedSongPaths.length
      })
      suppressNextLibraryClick()
      dragState.dragApproach = ''
      if (movedSongPaths.length > 0) {
        emitter.emit('songsMovedByDrag', movedSongPaths)
      }
      return
    }
    const shouldDelete = await handleDrop(e, dirData, dragState, fatherDirData)
    if (shouldDelete) {
      await deleteDir()
    }
  }

  return {
    dragApproach,
    dragstart,
    dragover,
    dragenter,
    dragleave,
    drop
  }
}
