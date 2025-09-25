import { ref, onUnmounted } from 'vue'
import type WaveSurfer from 'wavesurfer.js'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'

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
    if (coverBlobUrl.value) URL.revokeObjectURL(coverBlobUrl.value)
    coverBlobUrl.value = ''
  }

  const setCoverByIPC = async (filePath: string) => {
    try {
      const cover = await window.electron.ipcRenderer.invoke('getSongCover', filePath)
      if (cover && cover.data && filePath === runtime.playingData.playingSong?.filePath) {
        if (coverBlobUrl.value) URL.revokeObjectURL(coverBlobUrl.value)
        const blob = new Blob([new Uint8Array(cover.data).buffer], {
          type: cover.format || 'image/jpeg'
        })
        coverBlobUrl.value = URL.createObjectURL(blob)
      } else {
        disposeCoverUrl()
      }
    } catch (_) {
      disposeCoverUrl()
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
  })

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
