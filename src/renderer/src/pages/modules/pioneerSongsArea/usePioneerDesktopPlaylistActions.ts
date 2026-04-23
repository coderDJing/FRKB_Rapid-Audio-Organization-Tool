import { ref, type Ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { clearRekordboxSourceCache } from '@renderer/utils/rekordboxLibraryCache'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from '../../../../../types/globals'
import type {
  RekordboxDesktopRemovePlaylistTracksResponse,
  RekordboxDesktopReorderPlaylistTracksResponse
} from '@shared/rekordboxDesktopPlaylist'

export const usePioneerDesktopPlaylistActions = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  selectedPlaylistId: Ref<number>
  selectedSourceCacheKey: Ref<string>
  currentPlaybackListKey: Ref<string>
  visibleSongs: Ref<ISongInfo[]>
  selectedRowKeys: Ref<string[]>
  loadPlaylistTracks: () => Promise<void>
}) => {
  const {
    runtime,
    selectedPlaylistId,
    selectedSourceCacheKey,
    currentPlaybackListKey,
    visibleSongs,
    selectedRowKeys,
    loadPlaylistTracks
  } = params

  const playlistMutationPending = ref(false)

  const runWithPlaylistMutationPending = async <T>(task: () => Promise<T>): Promise<T> => {
    playlistMutationPending.value = true
    try {
      return await task()
    } finally {
      playlistMutationPending.value = false
    }
  }

  const showRekordboxFailureDialog = async (message: string, logPath?: string) => {
    const content = [
      t('rekordboxDesktop.failedReason', { message: message || t('common.unknownError') })
    ]
    if (logPath) {
      content.push(t('rekordboxDesktop.failureLogHint', { path: logPath }))
    }
    await confirm({
      title: t('rekordboxDesktop.failureTitle'),
      content,
      confirmShow: false,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left',
      canCopyText: Boolean(logPath)
    })
  }

  const syncPlaybackListFromVisibleSongs = () => {
    if (runtime.playingData.playingSongListUUID !== currentPlaybackListKey.value) return
    runtime.playingData.playingSongListData = [...visibleSongs.value]
  }

  const sortRowKeysByVisibleSongs = (rowKeys: string[]) => {
    const indexMap = new Map<string, number>()
    visibleSongs.value.forEach((item, index) => {
      const key = String(item.mixtapeItemId || '').trim()
      if (!key || indexMap.has(key)) return
      indexMap.set(key, index)
    })
    return [...rowKeys].sort((left, right) => {
      const leftIndex = indexMap.get(left)
      const rightIndex = indexMap.get(right)
      if (leftIndex === undefined && rightIndex === undefined) return 0
      if (leftIndex === undefined) return 1
      if (rightIndex === undefined) return -1
      return leftIndex - rightIndex
    })
  }

  const removeTracksFromDesktopPlaylist = async (selectedTracks: ISongInfo[], enabled: boolean) => {
    if (!enabled) return
    const playlistId = selectedPlaylistId.value
    const rowKeys = selectedTracks
      .map((item) => String(item.mixtapeItemId || '').trim())
      .filter(Boolean)
    if (!playlistId || rowKeys.length === 0) return

    const confirmContent =
      rowKeys.length === 1
        ? [
            t('rekordboxDesktop.removeTrackFromPlaylistConfirmLine1', {
              name: selectedTracks[0]?.title || t('tracks.unknownTrack')
            }),
            t('rekordboxDesktop.removeTracksFromPlaylistConfirmLine2')
          ]
        : [
            t('rekordboxDesktop.removeTracksFromPlaylistConfirmCount', { count: rowKeys.length }),
            t('rekordboxDesktop.removeTracksFromPlaylistConfirmLine2')
          ]
    const confirmResult = await confirm({
      title: t('rekordboxDesktop.removeTracksFromPlaylistTitle'),
      content: confirmContent,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left'
    })
    if (confirmResult !== 'confirm') return

    await runWithPlaylistMutationPending(async () => {
      try {
        if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
        const response = (await window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'remove-playlist-tracks'),
          {
            playlistId,
            rowKeys
          }
        )) as RekordboxDesktopRemovePlaylistTracksResponse

        if (!response.ok) {
          await showRekordboxFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }

        const removedKeySet = new Set(rowKeys)
        selectedRowKeys.value = []
        if (selectedSourceCacheKey.value) {
          clearRekordboxSourceCache(selectedSourceCacheKey.value)
        }

        if (runtime.playingData.playingSongListUUID === currentPlaybackListKey.value) {
          runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.filter(
            (item) => !removedKeySet.has(String(item.mixtapeItemId || '').trim())
          )
        }

        await loadPlaylistTracks()
        syncPlaybackListFromVisibleSongs()
      } catch (error) {
        await showRekordboxFailureDialog(
          error instanceof Error ? error.message : String(error || t('common.unknownError'))
        )
      }
    })
  }

  const reorderTracksInDesktopPlaylist = async (
    sourceItemIds: string[],
    targetIndex: number,
    enabled: boolean
  ) => {
    if (!enabled) return
    const playlistId = selectedPlaylistId.value
    const rowKeys = sortRowKeysByVisibleSongs(
      sourceItemIds.map((item) => String(item || '').trim()).filter(Boolean)
    )
    if (!playlistId || rowKeys.length === 0) return

    await runWithPlaylistMutationPending(async () => {
      try {
        if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
        const response = (await window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'reorder-playlist-tracks'),
          {
            playlistId,
            rowKeys,
            targetIndex
          }
        )) as RekordboxDesktopReorderPlaylistTracksResponse

        if (!response.ok) {
          await showRekordboxFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }

        if (selectedSourceCacheKey.value) {
          clearRekordboxSourceCache(selectedSourceCacheKey.value)
        }

        await loadPlaylistTracks()
        selectedRowKeys.value = rowKeys
        syncPlaybackListFromVisibleSongs()
      } catch (error) {
        await showRekordboxFailureDialog(
          error instanceof Error ? error.message : String(error || t('common.unknownError'))
        )
      }
    })
  }

  const renumberTracksInDesktopPlaylist = async (orderedSongs: ISongInfo[], enabled: boolean) => {
    if (!enabled) return
    const playlistId = selectedPlaylistId.value
    const rowKeys = orderedSongs
      .map((item) => String(item.mixtapeItemId || '').trim())
      .filter(Boolean)
    if (!playlistId || rowKeys.length <= 1) return

    await runWithPlaylistMutationPending(async () => {
      try {
        if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
        const response = (await window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'reorder-playlist-tracks'),
          {
            playlistId,
            rowKeys,
            targetIndex: 0
          }
        )) as RekordboxDesktopReorderPlaylistTracksResponse

        if (!response.ok) {
          await showRekordboxFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }

        if (selectedSourceCacheKey.value) {
          clearRekordboxSourceCache(selectedSourceCacheKey.value)
        }

        await loadPlaylistTracks()
        selectedRowKeys.value = rowKeys
        syncPlaybackListFromVisibleSongs()
      } catch (error) {
        await showRekordboxFailureDialog(
          error instanceof Error ? error.message : String(error || t('common.unknownError'))
        )
      }
    })
  }

  return {
    playlistMutationPending,
    removeTracksFromDesktopPlaylist,
    reorderTracksInDesktopPlaylist,
    renumberTracksInDesktopPlaylist
  }
}
