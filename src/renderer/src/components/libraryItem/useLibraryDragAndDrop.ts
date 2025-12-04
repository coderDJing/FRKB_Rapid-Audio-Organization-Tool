import { reactive, ref, watch } from 'vue'
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
  dirData: any
  fatherDirData: any
  deleteDir: () => Promise<void>
  props: { uuid: string }
  handleDropToSongList: (targetUuid: string, sourceUuid: string) => Promise<string[]>
  emitter: { emit: (event: string, payload?: any) => void }
}

export function useLibraryDragAndDrop({
  runtime,
  dirData,
  fatherDirData,
  deleteDir,
  props,
  handleDropToSongList,
  emitter
}: UseLibraryDragAndDropOptions) {
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
      await deleteDir()
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

  const handleSongDragGuard = (e: DragEvent) => {
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return true
    }
    const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')
    if (isSongDrag && dirData.type === 'songList') {
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
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }
    const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')
    if (isSongDrag && dirData.type === 'songList') {
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
    if (handleSongDragGuard(e)) {
      return
    }
    const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')
    if (isSongDrag && dirData.type === 'songList' && !isPlaylistInRecycleBin()) {
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
    if (handleSongDragGuard(e)) {
      return
    }
    const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')
    if (isSongDrag && dirData.type === 'songList') {
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
