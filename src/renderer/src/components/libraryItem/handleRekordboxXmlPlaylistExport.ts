import confirm from '@renderer/components/confirmDialog'
import {
  openRekordboxXmlExportForPlaylist,
  openRekordboxXmlExportForSelectedTracks
} from '@renderer/utils/rekordboxXmlExport'
import libraryUtils from '@renderer/utils/libraryUtils'
import { clearSongsAreaPaneBySongListUUID } from '@renderer/utils/songsAreaSplit'
import { t } from '@renderer/utils/translate'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IDir } from '../../../../types/globals'
import { loadSetPlaylistSongs } from './libraryContextMenuHelpers'

type LibraryItemEmitter = {
  emit: (event: string, payload?: unknown) => void
}

interface HandleRekordboxXmlPlaylistExportOptions {
  getDirData: () => IDir | null
  runtime: ReturnType<typeof useRuntimeStore>
  props: { uuid: string; libraryName: string }
  emitter: LibraryItemEmitter
  trackCount: { value: number | null }
  confirmTaskBusy: () => Promise<void>
}

export async function handleRekordboxXmlPlaylistExport({
  getDirData,
  runtime,
  props,
  emitter,
  trackCount,
  confirmTaskBusy
}: HandleRekordboxXmlPlaylistExportOptions) {
  if (runtime.isProgressing) {
    await confirmTaskBusy()
    return
  }
  const currentDirData = getDirData()
  const playlistName = String(currentDirData?.dirName || '').trim()
  if (currentDirData?.type === 'setList' || props.libraryName === 'SetLibrary') {
    runtime.isProgressing = true
    try {
      const tracks = await loadSetPlaylistSongs(props.uuid)
      if (!tracks.length) {
        await confirm({
          title: t('rekordboxXmlExport.failureTitle'),
          content: [t('rekordboxXmlExport.noTracksToExport')],
          confirmShow: false
        })
        return
      }
      const summary = await openRekordboxXmlExportForSelectedTracks({
        tracks,
        sourceLibraryName: 'SetLibrary',
        songListUUID: props.uuid,
        playlistName
      })
      if (summary?.mode === 'move' && summary.removedSetItemIds?.length) {
        const removedSetItemIds = summary.removedSetItemIds
        emitter.emit('songsRemoved', {
          listUUID: props.uuid,
          itemIds: removedSetItemIds
        })
        if (runtime.playingData.playingSongListUUID === props.uuid) {
          const removedIdSet = new Set(removedSetItemIds)
          runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.filter(
            (item) => !removedIdSet.has(item.setItemId || '')
          )
          if (
            runtime.playingData.playingSong?.setItemId &&
            removedIdSet.has(runtime.playingData.playingSong.setItemId)
          ) {
            runtime.playingData.playingSong = null
          }
        }
        if (runtime.setting.showPlaylistTrackCount) {
          trackCount.value = Math.max(0, Number(trackCount.value || 0) - removedSetItemIds.length)
        }
        try {
          emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
        } catch {}
      }
    } finally {
      runtime.isProgressing = false
    }
    return
  }
  if (props.libraryName !== 'FilterLibrary' && props.libraryName !== 'CuratedLibrary') {
    await confirm({
      title: t('rekordboxXmlExport.failureTitle'),
      content: [t('rekordboxXmlExport.unsupportedSource')],
      confirmShow: false
    })
    return
  }
  const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  runtime.isProgressing = true
  try {
    const summary = await openRekordboxXmlExportForPlaylist({
      sourceLibraryName: props.libraryName,
      songListUUID: props.uuid,
      songListPath,
      playlistName
    })
    if (summary?.mode === 'move') {
      clearSongsAreaPaneBySongListUUID(runtime, props.uuid)
      if (runtime.playingData.playingSongListUUID === props.uuid) {
        runtime.playingData.playingSongListUUID = ''
        runtime.playingData.playingSongListData = []
        runtime.playingData.playingSong = null
      }
      if (runtime.setting.showPlaylistTrackCount) {
        trackCount.value = 0
      }
      try {
        emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
      } catch {}
    }
  } finally {
    runtime.isProgressing = false
  }
}
