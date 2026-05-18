import type { ComputedRef, Ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from '../../../../../types/globals'

type UsePioneerSongDragParams = {
  selectedRowKeys: Ref<string[]>
  visibleSongs: Ref<ISongInfo[]>
  currentPlaybackListKey: ComputedRef<string>
  resolveSelectedTracks: (fallback?: ISongInfo) => ISongInfo[]
}

export const usePioneerSongDrag = (params: UsePioneerSongDragParams) => {
  const runtime = useRuntimeStore()

  const handleSongDragStart = (event: DragEvent, song: ISongInfo) => {
    const rowKey = song.mixtapeItemId || song.filePath
    if (!rowKey || !params.currentPlaybackListKey.value) return
    if (!params.selectedRowKeys.value.includes(rowKey)) {
      params.selectedRowKeys.value = [rowKey]
    }
    const selectedTracks = params.resolveSelectedTracks(song)
    const filePaths = selectedTracks.map((item) => item.filePath).filter(Boolean)
    if (!filePaths.length) return

    runtime.playingData.playingSongListUUID = params.currentPlaybackListKey.value
    runtime.playingData.playingSongListData = [...params.visibleSongs.value]
    runtime.songDragActive = true
    runtime.songDragMode = 'internal'
    runtime.draggingSongFilePaths = filePaths
    runtime.dragSourceSongListUUID = params.currentPlaybackListKey.value
    runtime.dragSourceMixtapeItemIds = selectedTracks
      .map((item) => String(item.mixtapeItemId || '').trim())
      .filter(Boolean)

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove'
      event.dataTransfer.setData(
        'application/x-song-drag',
        JSON.stringify({
          type: 'song',
          sourceLibraryName: 'PioneerDeviceLibrary',
          sourceSongListUUID: params.currentPlaybackListKey.value
        })
      )
    }
  }

  const handleSongDragEnd = () => {
    runtime.songDragSuppressClickUntilMs = Date.now() + 450
    window.setTimeout(() => {
      runtime.songDragActive = false
      runtime.songDragMode = ''
      runtime.draggingSongFilePaths = []
      runtime.dragSourceSongListUUID = ''
      runtime.dragSourceMixtapeItemIds = []
    }, 800)
  }

  return {
    handleSongDragStart,
    handleSongDragEnd
  }
}
