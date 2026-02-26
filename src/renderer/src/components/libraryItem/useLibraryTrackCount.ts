import { onMounted, ref, watch, type Ref } from 'vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '../../utils/mitt'

interface UseLibraryTrackCountOptions {
  runtime: any
  dirDataRef: Ref<any | null>
  props: { uuid: string }
}

export function useLibraryTrackCount({ runtime, dirDataRef, props }: UseLibraryTrackCountOptions) {
  const getDirData = () => dirDataRef.value

  const trackCount = ref<number | null>(null)
  let fetchingCount = false

  const ensureTrackCount = async () => {
    const dirData = getDirData()
    if (!runtime.setting.showPlaylistTrackCount) return
    if (fetchingCount) return
    if (!dirData || dirData.type !== 'songList') return
    try {
      fetchingCount = true
      const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
      const count = await window.electron.ipcRenderer.invoke('getSongListTrackCount', songListPath)
      trackCount.value = typeof count === 'number' ? count : 0
    } catch {
      trackCount.value = 0
    } finally {
      fetchingCount = false
    }
  }

  onMounted(() => {
    ensureTrackCount()
  })

  let debounceTimer: any = null
  const pendingSet = new Set<string>()
  emitter.on('playlistContentChanged', (payload: any) => {
    try {
      const uuids: string[] = (payload?.uuids || []).filter(Boolean)
      for (const u of uuids) pendingSet.add(u)
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (pendingSet.has(props.uuid)) {
          if (runtime.songsArea.songListUUID === props.uuid) {
            trackCount.value = runtime.songsArea.totalSongCount
          } else {
            ensureTrackCount()
          }
        }
        pendingSet.clear()
      }, 200)
    } catch {}
  })

  watch(
    () => [
      runtime.setting.showPlaylistTrackCount,
      dirDataRef.value?.type,
      dirDataRef.value?.dirName
    ],
    () => {
      if (runtime.setting.showPlaylistTrackCount) ensureTrackCount()
    }
  )

  return {
    trackCount,
    ensureTrackCount
  }
}
