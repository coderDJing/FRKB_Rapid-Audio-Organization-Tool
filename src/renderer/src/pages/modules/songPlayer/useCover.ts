import { ref, onUnmounted } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'

export function useCover(runtime: ReturnType<typeof useRuntimeStore>) {
  const coverBlobUrl = ref('')
  const songInfoShow = ref(false)
  const isShowingContextMenu = ref(false)
  const contextMenuCoverSnapshot = ref<{
    blobUrl: string
    songTitle: string
    artist: string
    format: string
  } | null>(null)

  const disposeCoverUrl = () => {
    if (coverBlobUrl.value && coverBlobUrl.value.startsWith('blob:')) {
      URL.revokeObjectURL(coverBlobUrl.value)
    }
    coverBlobUrl.value = ''
  }

  const toUint8Array = (raw: unknown): Uint8Array | null => {
    if (!raw) return null
    if (raw instanceof Uint8Array) return raw
    if (Array.isArray(raw)) return new Uint8Array(raw as number[])
    if (typeof raw === 'object' && (raw as any).data && Array.isArray((raw as any).data)) {
      return new Uint8Array((raw as any).data)
    }
    if (
      typeof raw === 'object' &&
      (raw as any).type === 'Buffer' &&
      Array.isArray((raw as any).data)
    ) {
      return new Uint8Array((raw as any).data)
    }
    return null
  }

  const applyCoverBytes = (bytes: Uint8Array, format?: string) => {
    disposeCoverUrl()
    const cloned = bytes.slice()
    const blob = new Blob([cloned], {
      type: format || 'image/jpeg'
    })
    coverBlobUrl.value = URL.createObjectURL(blob)
  }

  const setCoverByIPC = async (filePath: string) => {
    const preferLargerThumb = await fetchCoverFromCache(filePath, 512)
    if (preferLargerThumb) return

    const fallbackThumb = await fetchCoverFromCache(filePath, 256)
    if (fallbackThumb) return

    const stillCurrent = filePath === runtime.playingData.playingSong?.filePath
    if (stillCurrent) {
      disposeCoverUrl()
    }
  }

  const fetchCoverFromCache = async (filePath: string, size: number = 256): Promise<boolean> => {
    try {
      const songListUUID = runtime.playingData.playingSongListUUID
      const rootDir = songListUUID ? libraryUtils.findDirPathByUuid(songListUUID) : undefined
      const thumb = await window.electron.ipcRenderer.invoke(
        'getSongCoverThumb',
        filePath,
        size,
        rootDir || ''
      )
      if (!thumb || filePath !== runtime.playingData.playingSong?.filePath) {
        return false
      }
      if (thumb.data) {
        const bytes = toUint8Array(thumb.data)
        if (bytes && bytes.length > 0) {
          applyCoverBytes(bytes, thumb.format)
          return true
        }
      }
      if (thumb.dataUrl && typeof thumb.dataUrl === 'string') {
        disposeCoverUrl()
        coverBlobUrl.value = thumb.dataUrl
        return true
      }
      disposeCoverUrl()
      return false
    } catch (cacheError) {
      disposeCoverUrl()
      return false
    }
  }

  const handleSongMetadataUpdated = (payload: { filePath?: string }) => {
    const filePath = payload?.filePath
    if (!filePath) return
    if (runtime.playingData.playingSong?.filePath === filePath) {
      setCoverByIPC(filePath)
    }
  }

  const handleSongInfoMouseLeave = () => {
    if (isShowingContextMenu.value) return
    songInfoShow.value = false
  }

  const saveCoverAs = () => {
    if (!contextMenuCoverSnapshot.value) return
    const snapshot = contextMenuCoverSnapshot.value

    let extension = 'jpg'
    if (snapshot.format) {
      if (snapshot.format.includes('png')) extension = 'png'
      else if (snapshot.format.includes('jpeg') || snapshot.format.includes('jpg'))
        extension = 'jpg'
    }
    const suggestedName = `${snapshot.artist} - ${snapshot.songTitle}.${extension}`
    const link = document.createElement('a')
    link.href = snapshot.blobUrl
    link.download = suggestedName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const showCoverContextMenu = async (event: MouseEvent) => {
    if (!coverBlobUrl.value) return

    setTimeout(async () => {
      isShowingContextMenu.value = true
      const currentSong = runtime.playingData.playingSong
      if (currentSong && coverBlobUrl.value) {
        contextMenuCoverSnapshot.value = {
          blobUrl: coverBlobUrl.value,
          songTitle: currentSong.title || t('tracks.unknownTrack'),
          artist: currentSong.artist || t('tracks.unknownArtist'),
          format: 'image/jpeg'
        }
      }

      const menuArr = [[{ menuName: 'tracks.saveCoverAs', shortcutKey: '' }]]
      const result = await rightClickMenu({ menuArr, clickEvent: event })
      isShowingContextMenu.value = false
      if (result !== 'cancel' && result.menuName === 'tracks.saveCoverAs') {
        saveCoverAs()
      }
      contextMenuCoverSnapshot.value = null
    }, 0)
  }

  onUnmounted(() => {
    disposeCoverUrl()
    emitter.off('songMetadataUpdated', handleSongMetadataUpdated)
  })

  emitter.on('songMetadataUpdated', handleSongMetadataUpdated)

  return {
    coverBlobUrl,
    songInfoShow,
    isShowingContextMenu,
    contextMenuCoverSnapshot,
    setCoverByIPC,
    handleSongInfoMouseLeave,
    showCoverContextMenu,
    saveCoverAs,
    disposeCoverUrl
  }
}
