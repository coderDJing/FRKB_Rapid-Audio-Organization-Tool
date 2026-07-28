import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  IPioneerPlaylistTrack,
  IRekordboxSourceKind,
  ISongInfo
} from '../../../../../types/globals'

type UsePioneerPlaylistTracksParams = {
  selectedSourceCacheKey: ComputedRef<string>
  selectedPlaylistId: ComputedRef<number>
  selectedSourceKind: ComputedRef<IRekordboxSourceKind | ''>
  selectedSourceRootPath: ComputedRef<string>
  selectedLibraryType: ComputedRef<string>
  originalTracks: ShallowRef<IPioneerPlaylistTrack[]>
  visibleSongs: Ref<ISongInfo[]>
  loading: Ref<boolean>
  selectedRowKeys: Ref<string[]>
  applyFiltersAndSorting: (reason?: string) => void
  isCurrentPlaylistLoadTarget: (sourceCacheKey: string, playlistId: number) => boolean
  emitPioneerSongsAreaLog: (event: string, payload?: Record<string, unknown>) => void
}

type FetchPlaylistTracksParams = {
  sourceCacheKey: string
  playlistId: number
  sourceKind: IRekordboxSourceKind
  rootPath: string
  libraryType: string
}

export const usePioneerPlaylistTracks = (params: UsePioneerPlaylistTracksParams) => {
  let playlistTracksRequestToken = 0

  const fetchPlaylistTracks = async (fetchParams: FetchPlaylistTracksParams) => {
    const requestToken = ++playlistTracksRequestToken
    const { sourceCacheKey, playlistId, sourceKind, rootPath, libraryType } = fetchParams

    try {
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-start', {
        requestToken,
        sourceCacheKey
      })
      const result =
        sourceKind === 'desktop'
          ? await window.electron.ipcRenderer.invoke(
              buildRekordboxSourceChannel('desktop', 'load-playlist-tracks'),
              playlistId
            )
          : await window.electron.ipcRenderer.invoke(
              buildRekordboxSourceChannel('usb', 'load-playlist-tracks'),
              rootPath,
              playlistId,
              libraryType
            )
      const tracks = Array.isArray(result?.tracks) ? result.tracks : []
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-success', {
        requestToken,
        returnedTrackCount: tracks.length,
        firstTracks: tracks.slice(0, 5).map((track: IPioneerPlaylistTrack) => ({
          rowKey: track.rowKey,
          title: track.title,
          filePath: track.filePath
        }))
      })

      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      if (requestToken !== playlistTracksRequestToken) return

      params.originalTracks.value = tracks
      params.applyFiltersAndSorting('fetch-playlist-tracks-success')
    } catch (error) {
      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      if (requestToken !== playlistTracksRequestToken) return

      console.error('[pioneerSongsArea] load playlist tracks failed', error)
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-failed', {
        requestToken,
        error
      })
      params.originalTracks.value = []
      params.visibleSongs.value = []
    } finally {
      if (
        params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId) &&
        requestToken === playlistTracksRequestToken
      ) {
        params.loading.value = false
      }
    }
  }

  const loadPlaylistTracks = async () => {
    const sourceCacheKey = params.selectedSourceCacheKey.value
    const playlistId = params.selectedPlaylistId.value
    const sourceKind = params.selectedSourceKind.value || 'usb'
    const rootPath = params.selectedSourceRootPath.value
    const libraryType = params.selectedLibraryType.value

    if (!rootPath || !playlistId || !sourceCacheKey) {
      playlistTracksRequestToken += 1
      params.loading.value = false
      params.originalTracks.value = []
      params.visibleSongs.value = []
      params.selectedRowKeys.value = []
      params.emitPioneerSongsAreaLog('load-playlist-tracks-reset-empty-selection', {
        sourceCacheKey,
        rootPath,
        playlistId
      })
      return
    }

    params.selectedRowKeys.value = []
    params.emitPioneerSongsAreaLog('load-playlist-tracks-enter', {
      sourceCacheKey
    })
    params.loading.value = true
    params.originalTracks.value = []
    params.visibleSongs.value = []

    await fetchPlaylistTracks({
      sourceCacheKey,
      playlistId,
      sourceKind,
      rootPath,
      libraryType
    })
  }

  return {
    loadPlaylistTracks
  }
}
