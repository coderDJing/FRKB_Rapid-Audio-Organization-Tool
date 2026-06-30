import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '../../utils/mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IDir } from '../../../../types/globals'

interface UseLibraryTrackCountOptions {
  runtime: ReturnType<typeof useRuntimeStore>
  dirDataRef: Ref<IDir | null>
  props: { uuid: string }
}

type PlaylistContentChangedPayload = {
  uuids?: string[]
}

export function useLibraryTrackCount({ runtime, dirDataRef, props }: UseLibraryTrackCountOptions) {
  const getDirData = () => dirDataRef.value

  const trackCount = ref<number | null>(null)
  let fetchingCount = false

  const ensureTrackCount = async () => {
    const dirData = getDirData()
    if (!runtime.setting.showPlaylistTrackCount) return
    if (fetchingCount) return
    if (!dirData || (dirData.type !== 'songList' && dirData.type !== 'setList')) return
    try {
      fetchingCount = true
      if (dirData.type === 'setList') {
        const count = await window.electron.ipcRenderer.invoke('setList:count', props.uuid)
        trackCount.value = typeof count === 'number' ? count : 0
        return
      }
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

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const pendingSet = new Set<string>()
  const handlePlaylistContentChanged = (payload: unknown) => {
    try {
      const resolvedPayload =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as PlaylistContentChangedPayload)
          : {}
      const uuids = Array.isArray(resolvedPayload.uuids)
        ? resolvedPayload.uuids.filter((item): item is string => typeof item === 'string' && !!item)
        : []
      for (const u of uuids) pendingSet.add(u)
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
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
  }
  emitter.on('playlistContentChanged', handlePlaylistContentChanged)

  onUnmounted(() => {
    emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    pendingSet.clear()
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
