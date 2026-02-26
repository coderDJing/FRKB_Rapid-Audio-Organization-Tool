import { reactive, ref, watch, type Ref } from 'vue'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'

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

  const handleSongDragGuard = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return true
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return true
    }
    const isSongDrag = isInternalSongDrag(e)
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
    if (isInternalDrag && (dirData.type === 'songList' || dirData.type === 'mixtapeList')) {
      if (isPlaylistInRecycleBin()) {
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'none'
        }
        return
      }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move'
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
    if (handleSongDragGuard(e)) {
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (isInternalDrag && (dirData.type === 'songList' || dirData.type === 'mixtapeList')) {
      if (isPlaylistInRecycleBin()) {
        dragState.dragApproach = ''
        return
      }
      e.preventDefault()
      const movedSongPaths = await handleDropToSongList(props.uuid, runtime.libraryAreaSelected)
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
