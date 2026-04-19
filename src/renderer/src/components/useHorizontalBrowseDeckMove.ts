import { nextTick, ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import {
  resolveLibraryTransferActionModeForPlayback,
  type LibraryTransferActionMode
} from '@renderer/utils/libraryTransfer'

export type HorizontalBrowseDeckMoveTargetLibrary =
  | 'CuratedLibrary'
  | 'FilterLibrary'
  | 'MixtapeLibrary'

type UseHorizontalBrowseDeckMoveParams = {
  getDeckSong: (deck: HorizontalBrowseDeckKey) => ISongInfo | null
  setDeckSong: (deck: HorizontalBrowseDeckKey, song: ISongInfo | null) => void
}

const normalizePath = (value: string | null | undefined) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const resolveFileNameAndFormat = (filePath: string) => {
  const baseName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  return {
    fileName: baseName,
    fileFormat: ext ? ext.toUpperCase() : ''
  }
}

const buildSongSnapshot = (filePath: string, song?: ISongInfo | null): ISongInfo => {
  const meta = resolveFileNameAndFormat(filePath)
  return {
    filePath,
    fileName: song?.fileName || meta.fileName,
    fileFormat: song?.fileFormat || meta.fileFormat,
    cover: null,
    title: song?.title ?? meta.fileName,
    artist: song?.artist,
    album: song?.album,
    duration: song?.duration ?? '',
    genre: song?.genre,
    label: song?.label,
    bitrate: song?.bitrate,
    container: song?.container,
    key: song?.key,
    bpm: song?.bpm,
    firstBeatMs: song?.firstBeatMs,
    barBeatOffset: song?.barBeatOffset,
    hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : [],
    mixOrder: song?.mixOrder,
    mixtapeItemId: song?.mixtapeItemId,
    analysisOnly: false,
    autoFilled: song?.autoFilled
  }
}

const buildMovedDeckSong = (song: ISongInfo, nextFilePath: string): ISongInfo => {
  const meta = resolveFileNameAndFormat(nextFilePath)
  return {
    ...song,
    filePath: nextFilePath,
    fileName: meta.fileName,
    fileFormat: meta.fileFormat,
    externalAnalyzePath: null,
    externalWaveformRootPath: null,
    externalSourceKind: null,
    pioneerCoverPath: null,
    pioneerAnalyzePath: null,
    pioneerDeviceRootPath: null
  }
}

export const useHorizontalBrowseDeckMove = (params: UseHorizontalBrowseDeckMoveParams) => {
  const runtime = useRuntimeStore()
  const selectSongListDialogVisible = ref(false)
  const selectSongListDialogTargetLibraryName = ref<HorizontalBrowseDeckMoveTargetLibrary | ''>('')
  const selectSongListDialogActionMode = ref<LibraryTransferActionMode>('move')
  const pendingDeck = ref<HorizontalBrowseDeckKey | null>(null)

  const getDeckSong = (deck: HorizontalBrowseDeckKey) => params.getDeckSong(deck)
  const setDeckSong = (deck: HorizontalBrowseDeckKey, song: ISongInfo | null) =>
    params.setDeckSong(deck, song)

  const clearPendingState = () => {
    selectSongListDialogVisible.value = false
    selectSongListDialogTargetLibraryName.value = ''
    pendingDeck.value = null
  }

  const isDeckSongReadOnly = (deck: HorizontalBrowseDeckKey) => {
    const song = getDeckSong(deck)
    if (!song) return false
    if (isRekordboxExternalPlaybackSource('', song)) return true
    if (song.mixtapeItemId) return true
    const currentSongsAreaListUuid = runtime.songsArea.songListUUID
    const currentSongsAreaNode = libraryUtils.getLibraryTreeByUUID(currentSongsAreaListUuid)
    const currentSongsAreaContainsSong = runtime.songsArea.songInfoArr.some(
      (item) => normalizePath(item.filePath) === normalizePath(song.filePath)
    )
    return Boolean(currentSongsAreaContainsSong && currentSongsAreaNode?.type === 'mixtapeList')
  }

  const openDeckMoveDialog = (
    deck: HorizontalBrowseDeckKey,
    libraryName: HorizontalBrowseDeckMoveTargetLibrary
  ) => {
    if (!getDeckSong(deck)) return
    pendingDeck.value = deck
    selectSongListDialogTargetLibraryName.value = libraryName
    selectSongListDialogActionMode.value = isDeckSongReadOnly(deck) ? 'copy' : 'move'
    selectSongListDialogVisible.value = true
  }

  const refreshSongsAreaListIfNeeded = async (targetSongListUUID: string) => {
    if (!targetSongListUUID || runtime.songsArea.songListUUID !== targetSongListUUID) return
    const currentListUuid = runtime.songsArea.songListUUID
    runtime.songsArea.songListUUID = ''
    await nextTick()
    runtime.songsArea.songListUUID = currentListUuid
  }

  const handleDeckMoveSong = async (targetSongListUUID: string) => {
    const deck = pendingDeck.value
    const targetLibraryName = selectSongListDialogTargetLibraryName.value
    clearPendingState()

    if (!deck || !targetSongListUUID || !targetLibraryName) return

    const song = getDeckSong(deck)
    if (!song?.filePath) return
    try {
      const readOnlySource = selectSongListDialogActionMode.value === 'copy'
      const requiresVaultCopy = isRekordboxExternalPlaybackSource('', song)
      const currentSongsAreaListUuid = runtime.songsArea.songListUUID
      const currentSongsAreaNode = libraryUtils.getLibraryTreeByUUID(currentSongsAreaListUuid)
      const currentSongsAreaContainsSong = runtime.songsArea.songInfoArr.some(
        (item) => normalizePath(item.filePath) === normalizePath(song.filePath)
      )
      const sourceResolution = (await window.electron.ipcRenderer.invoke(
        'songList:resolve-by-file-path',
        song.filePath
      )) as {
        songListUuid?: string
        songListPath?: string
      } | null
      const sourceSongListUuid = String(sourceResolution?.songListUuid || '')
      const sourceActionMode = readOnlySource
        ? 'copy'
        : resolveLibraryTransferActionModeForPlayback(sourceSongListUuid, song)
      const currentSongListIsSource =
        currentSongsAreaContainsSong && sourceSongListUuid === currentSongsAreaListUuid

      if (
        sourceActionMode === 'move' &&
        ((sourceSongListUuid && sourceSongListUuid === targetSongListUUID) ||
          (currentSongListIsSource && currentSongsAreaListUuid === targetSongListUUID))
      ) {
        return
      }

      const targetNode = libraryUtils.getLibraryTreeByUUID(targetSongListUUID)
      const isMixtapeTarget =
        targetNode?.type === 'mixtapeList' || targetLibraryName === 'MixtapeLibrary'

      if (isMixtapeTarget) {
        if (readOnlySource) {
          let copiedPath = song.filePath
          if (requiresVaultCopy) {
            const copiedTracks = (await window.electron.ipcRenderer.invoke(
              'mixtape:copy-files-to-vault',
              {
                filePaths: [song.filePath]
              }
            )) as Array<{ sourcePath: string; targetPath: string }>
            copiedPath = String(copiedTracks[0]?.targetPath || '').trim()
          }
          if (!copiedPath) {
            throw new Error('MIXTAPE_COPY_TO_VAULT_FAILED')
          }
          await window.electron.ipcRenderer.invoke('mixtape:append', {
            playlistId: targetSongListUUID,
            items: [
              {
                filePath: copiedPath,
                originPathSnapshot:
                  runtime.pioneerDeviceLibrary.selectedSourceName || 'Pioneer USB',
                info: buildSongSnapshot(copiedPath, song)
              }
            ]
          })
          setDeckSong(deck, buildMovedDeckSong(song, copiedPath))
        } else {
          await window.electron.ipcRenderer.invoke('mixtape:append', {
            playlistId: targetSongListUUID,
            items: [
              {
                filePath: song.filePath,
                originPlaylistUuid: sourceSongListUuid || currentSongsAreaListUuid,
                originPathSnapshot:
                  libraryUtils.buildDisplayPathByUuid(
                    sourceSongListUuid || currentSongsAreaListUuid
                  ) || '',
                info: buildSongSnapshot(song.filePath, song)
              }
            ]
          })
        }

        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message: t('mixtape.addedToMixtape', { count: 1 })
        })
        await refreshSongsAreaListIfNeeded(targetSongListUUID)
        return
      }

      const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)
      if (!targetDirPath) {
        throw new Error(`target song list path not found: ${targetSongListUUID}`)
      }

      const movedPaths = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        [song.filePath],
        targetDirPath,
        readOnlySource
          ? {
              mode: 'copy',
              curatedArtistNames: [song.artist || '']
            }
          : {
              curatedArtistNames: [song.artist || '']
            }
      )) as string[]
      const nextFilePath = String(movedPaths?.[0] || '').trim()
      if (!nextFilePath) {
        throw new Error('deck move returned empty target path')
      }
      await copySongCueDefinitionsToTargets([
        {
          targetFilePath: nextFilePath,
          sourceSong: song
        }
      ])

      setDeckSong(deck, buildMovedDeckSong(song, nextFilePath))

      if (!readOnlySource && currentSongListIsSource && currentSongsAreaNode?.type === 'songList') {
        emitter.emit('songsRemoved', {
          listUUID: currentSongsAreaListUuid,
          paths: [song.filePath]
        })
      }

      if (
        sourceActionMode === 'move' &&
        currentSongsAreaContainsSong &&
        currentSongsAreaNode?.type === 'mixtapeList'
      ) {
        await refreshSongsAreaListIfNeeded(currentSongsAreaListUuid)
      }

      emitter.emit('playlistContentChanged', {
        uuids: [sourceSongListUuid, targetSongListUUID].filter(Boolean)
      })

      await refreshSongsAreaListIfNeeded(targetSongListUUID)
    } catch (error) {
      console.error('[horizontal-browse] move deck song failed', error)
    }
  }

  const handleDeckMoveDialogCancel = () => {
    clearPendingState()
  }

  return {
    selectSongListDialogVisible,
    selectSongListDialogTargetLibraryName,
    selectSongListDialogActionMode,
    isDeckSongReadOnly,
    openDeckMoveDialog,
    handleDeckMoveSong,
    handleDeckMoveDialogCancel
  }
}
