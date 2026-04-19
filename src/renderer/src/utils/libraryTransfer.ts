import type { ISongInfo } from '../../../types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'

export type LibraryTransferActionMode = 'move' | 'copy'
export type LibraryTransferTarget = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary'

export const resolveLibraryTransferActionModeForSongList = (
  songListUUID: string
): LibraryTransferActionMode => {
  const node = libraryUtils.getLibraryTreeByUUID(songListUUID)
  if (node?.type === 'mixtapeList') return 'copy'
  return 'move'
}

export const resolveLibraryTransferActionModeForPlayback = (
  songListUUID: string,
  song?: ISongInfo | null
): LibraryTransferActionMode => {
  if (isRekordboxExternalPlaybackSource(songListUUID, song || null)) {
    return 'copy'
  }
  return resolveLibraryTransferActionModeForSongList(songListUUID)
}

export const resolveLibraryTransferActionLabelKey = (
  targetLibrary: LibraryTransferTarget,
  actionMode: LibraryTransferActionMode
) => {
  if (targetLibrary === 'MixtapeLibrary') {
    return actionMode === 'copy' ? 'library.addToMixtapeByCopy' : 'library.addToMixtape'
  }
  if (targetLibrary === 'FilterLibrary') {
    return actionMode === 'copy' ? 'library.copyToFilter' : 'library.moveToFilter'
  }
  return actionMode === 'copy' ? 'library.copyToCurated' : 'library.moveToCurated'
}

export const isCopyTransferActionMode = (actionMode: LibraryTransferActionMode) =>
  actionMode === 'copy'
