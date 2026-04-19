import { computed, ref } from 'vue'
import { type ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import type { ISongInfo } from '../../../../../../types/globals'
import {
  resolveLibraryTransferActionModeForSongList,
  type LibraryTransferActionMode
} from '@renderer/utils/libraryTransfer'

export type MoveSongsLibraryName = 'CuratedLibrary' | 'FilterLibrary' | 'MixtapeLibrary'

interface UseSelectAndMoveSongsParams {
  songsAreaState: ISongsAreaPaneRuntimeState
}

export function useSelectAndMoveSongs(params: UseSelectAndMoveSongsParams) {
  const { songsAreaState } = params
  const runtime = useRuntimeStore()
  const normalizeUniqueStrings = (values: unknown[]): string[] =>
    Array.from(
      new Set(
        values
          .filter((value) => typeof value === 'string')
          .map((value) => String(value).trim())
          .filter(Boolean)
      )
    )
  const resolveFileNameAndFormat = (filePath: string) => {
    const baseName =
      String(filePath || '')
        .split(/[/\\]/)
        .pop() || ''
    const parts = baseName.split('.')
    const ext = parts.length > 1 ? parts.pop() || '' : ''
    const fileFormat = ext ? ext.toUpperCase() : ''
    return { fileName: baseName, fileFormat }
  }
  const buildSongSnapshot = (filePath: string, song?: ISongInfo | null) => {
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
      originalKey: song?.key,
      bpm: song?.bpm,
      originalBpm: song?.bpm,
      firstBeatMs: song?.firstBeatMs,
      barBeatOffset: song?.barBeatOffset,
      hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
      memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
    }
  }

  const isDialogVisible = ref(false)
  const targetLibraryName = ref<MoveSongsLibraryName | ''>('')
  const dialogActionMode = computed<LibraryTransferActionMode>(() =>
    resolveLibraryTransferActionModeForSongList(songsAreaState.songListUUID)
  )

  const initiateMoveSongs = (libraryName: MoveSongsLibraryName) => {
    targetLibraryName.value = libraryName
    isDialogVisible.value = true
  }

  /**
   * Handles the confirmation from the select song list dialog.
   * Moves selected songs to the chosen directory and updates the store.
   * @param targetSongListUUID - The UUID of the target song list.
   */
  const handleMoveSongsConfirm = async (targetSongListUUID: string) => {
    isDialogVisible.value = false
    if (targetSongListUUID === songsAreaState.songListUUID) {
      // Moving to the same list, do nothing.
      return
    }

    const sourceSongListUUID = songsAreaState.songListUUID
    const sourceActionMode = resolveLibraryTransferActionModeForSongList(sourceSongListUUID)
    const selectedPaths = JSON.parse(JSON.stringify(songsAreaState.selectedSongFilePath))
    const songMap = new Map(songsAreaState.songInfoArr.map((song) => [song.filePath, song]))
    if (!selectedPaths.length) return

    const targetNode = libraryUtils.getLibraryTreeByUUID(targetSongListUUID)
    const sourceNode = libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)
    const isMixtapeTarget =
      targetNode?.type === 'mixtapeList' || targetLibraryName.value === 'MixtapeLibrary'
    if (isMixtapeTarget) {
      if (!sourceNode || (sourceNode.type !== 'songList' && sourceNode.type !== 'mixtapeList')) {
        return
      }
      const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(sourceSongListUUID)
      const mixtapeSongMap = new Map(
        songsAreaState.songInfoArr
          .filter((song) => typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.length > 0)
          .map((song) => [song.mixtapeItemId as string, song])
      )
      const itemsFromMixtapeIds = normalizeUniqueStrings(selectedPaths)
        .map((itemId) => {
          const song = mixtapeSongMap.get(itemId)
          const filePath = song?.filePath || ''
          if (!song || !filePath) return null
          return {
            filePath,
            originPlaylistUuid: sourceSongListUUID,
            originPathSnapshot,
            info: buildSongSnapshot(filePath, song),
            sourcePlaylistId: sourceSongListUUID,
            sourceItemId: itemId
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      const itemsFromMixtapePaths = normalizeUniqueStrings(selectedPaths)
        .map((filePath) => {
          const song = songMap.get(filePath)
          if (!song || !song.filePath) return null
          return {
            filePath: song.filePath,
            originPlaylistUuid: sourceSongListUUID,
            originPathSnapshot,
            info: buildSongSnapshot(song.filePath, song),
            sourcePlaylistId: sourceSongListUUID,
            sourceItemId:
              typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.trim()
                ? song.mixtapeItemId.trim()
                : undefined
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      const items =
        sourceNode.type === 'mixtapeList'
          ? itemsFromMixtapeIds.length > 0
            ? itemsFromMixtapeIds
            : itemsFromMixtapePaths
          : normalizeUniqueStrings(selectedPaths).map((filePath: string) => ({
              filePath,
              originPlaylistUuid: sourceSongListUUID,
              originPathSnapshot,
              info: buildSongSnapshot(filePath, songMap.get(filePath))
            }))
      if (items.length === 0) return
      await window.electron.ipcRenderer.invoke('mixtape:append', {
        playlistId: targetSongListUUID,
        items
      })
      songsAreaState.selectedSongFilePath.length = 0
      try {
        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message: t('mixtape.addedToMixtape', { count: items.length })
        })
      } catch {}
      return
    }

    if (sourceActionMode === 'copy') {
      const selectedSourceItems = normalizeUniqueStrings(selectedPaths)
        .map((key) => {
          const song =
            songsAreaState.songInfoArr.find(
              (item) => typeof item.mixtapeItemId === 'string' && item.mixtapeItemId.trim() === key
            ) || songMap.get(key)
          if (!song?.filePath) return null
          return {
            filePath: song.filePath,
            song
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      if (!selectedSourceItems.length) return

      const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)
      if (!targetDirPath) return

      const copiedPaths = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        selectedSourceItems.map((item) => item.filePath),
        targetDirPath,
        {
          mode: 'copy',
          curatedArtistNames: selectedSourceItems.map((item) => item.song.artist || '')
        }
      )) as string[]
      await copySongCueDefinitionsToTargets(
        copiedPaths.map((targetFilePath, index) => ({
          targetFilePath,
          sourceSong: selectedSourceItems[index]?.song
        }))
      )

      songsAreaState.selectedSongFilePath.length = 0
      try {
        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', { action: 'copy' })
      } catch {}
      return
    }

    const movedPaths = (await window.electron.ipcRenderer.invoke(
      'moveSongsToDir',
      selectedPaths,
      libraryUtils.findDirPathByUuid(targetSongListUUID),
      {
        curatedArtistNames: selectedPaths.map(
          (filePath: string) => songMap.get(filePath)?.artist || ''
        )
      }
    )) as string[]
    await copySongCueDefinitionsToTargets(
      movedPaths.map((targetFilePath, index) => ({
        targetFilePath,
        sourceSong: songMap.get(selectedPaths[index])
      }))
    )

    // 不在此处直接修改 original 或 runtime.songsArea.songInfoArr，
    // 统一通过全局事件在 songsArea.vue 中处理，避免与排序/筛选链路竞态。
    songsAreaState.selectedSongFilePath.length = 0 // 清空选择

    // 通知全局，保证 songsArea 与其他视图收到统一的移除事件
    emitter.emit('songsRemoved', {
      listUUID: songsAreaState.songListUUID,
      paths: selectedPaths
    })

    // 同步通知源/目标歌单数量刷新
    try {
      const affected = [sourceSongListUUID, targetSongListUUID].filter(Boolean)
      emitter.emit('playlistContentChanged', { uuids: affected })
    } catch {}
  }

  const handleDialogCancel = () => {
    isDialogVisible.value = false
  }

  return {
    isDialogVisible, // To be bound to v-if or v-model of the dialog component
    targetLibraryName, // To be passed as a prop to the dialog component
    dialogActionMode,
    initiateMoveSongs, // To be called by the parent component to start the process
    handleMoveSongsConfirm, // To be called by the dialog component on confirm event
    handleDialogCancel // To be called by the dialog component on cancel event
  }
}
