import type { ISongInfo } from 'src/types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { useRuntimeStore } from '@renderer/stores/runtime'

const CORE_WRITABLE_LIBRARIES = new Set(['FilterLibrary', 'CuratedLibrary'])

const resolveLibraryNameFromPath = (dirPath: string) => {
  const segments = String(dirPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  const libraryIndex = segments.findIndex(
    (segment) =>
      segment === 'FilterLibrary' ||
      segment === 'CuratedLibrary' ||
      segment === 'RecordingLibrary' ||
      segment === 'MixtapeLibrary' ||
      segment === 'RecycleBin'
  )
  return libraryIndex >= 0 ? segments[libraryIndex] : ''
}

export const resolveAudioEditListRoot = (songListUUID: string) => {
  const uuid = String(songListUUID || '').trim()
  if (!uuid) return ''
  return String(libraryUtils.findDirPathByUuid(uuid) || '').trim()
}

export const isWritableFrkbAudioEditContext = (params: {
  song: ISongInfo | null | undefined
  songListUUID?: string | null
}) => {
  const song = params.song
  if (!song?.filePath) return false
  if (song.mixtapeItemId) return false
  if (isRekordboxExternalPlaybackSource(params.songListUUID, song)) return false
  const runtime = useRuntimeStore()
  const songListUUID = String(
    params.songListUUID || runtime.horizontalBrowseDecks.topSongListUUID || ''
  )
  const node = libraryUtils.getLibraryTreeByUUID(songListUUID)
  if (!node || (node.type !== 'songList' && node.type !== 'setList')) return false
  const listRoot = resolveAudioEditListRoot(songListUUID)
  const libraryName = resolveLibraryNameFromPath(listRoot)
  if (!CORE_WRITABLE_LIBRARIES.has(libraryName)) return false
  return true
}
