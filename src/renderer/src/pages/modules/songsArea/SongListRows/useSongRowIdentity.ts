import { computed } from 'vue'
import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'

export const useSongRowIdentity = (params: {
  songListRootDir: Ref<string | undefined>
  reorderMode: Ref<'none' | 'mixtape' | 'playlist'>
}) => {
  const isPlaylistReorder = computed(() => params.reorderMode.value === 'playlist')
  const isNormalLibraryContext = computed(() => {
    const rootDir = String(params.songListRootDir.value || '').replace(/\\/g, '/')
    return (
      rootDir === 'library/FilterLibrary' ||
      rootDir.startsWith('library/FilterLibrary/') ||
      rootDir === 'library/CuratedLibrary' ||
      rootDir.startsWith('library/CuratedLibrary/')
    )
  })
  const isPioneerLibraryContext = computed(() =>
    String(params.songListRootDir.value || '')
      .replace(/\\/g, '/')
      .startsWith('library/PioneerDeviceLibrary')
  )
  const shouldDisplayPlaylistTrackNumber = computed(
    () => isNormalLibraryContext.value || isPioneerLibraryContext.value
  )

  const getRowKey = (song: ISongInfo) => {
    if (song.setItemId) return song.setItemId
    const shouldUseItemId =
      isPioneerLibraryContext.value || !isNormalLibraryContext.value || isPlaylistReorder.value
    return shouldUseItemId && song.mixtapeItemId ? song.mixtapeItemId : song.filePath
  }

  const getCellKey = (song: ISongInfo, colKey: string) => `${getRowKey(song)}__${colKey}`

  const getIndexCellValue = (song: ISongInfo, index: number) => {
    if (typeof song.mixOrder === 'number' && song.mixOrder > 0) return song.mixOrder
    if (
      shouldDisplayPlaylistTrackNumber.value &&
      typeof song.playlistTrackNumber === 'number' &&
      song.playlistTrackNumber > 0
    ) {
      return song.playlistTrackNumber
    }
    return index + 1
  }

  return {
    isPlaylistReorder,
    isNormalLibraryContext,
    isPioneerLibraryContext,
    getRowKey,
    getCellKey,
    getIndexCellValue
  }
}
