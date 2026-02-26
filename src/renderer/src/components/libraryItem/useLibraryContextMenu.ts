import { ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import exportDialog from '@renderer/components/exportDialog'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import type { IMetadataAutoFillSummary } from '../../../../types/globals'

interface UseLibraryContextMenuOptions {
  dirData: any
  fatherDirData: any
  runtime: any
  props: { uuid: string; libraryName: string }
  emitter: { emit: (event: string, payload?: any) => void }
  dirChildRendered: { value: boolean }
  dirChildShow: { value: boolean }
  trackCount: { value: number | null }
  warnAcoustIdMissing: () => void
  startRename: () => Promise<void> | void
}

export function useLibraryContextMenu({
  dirData,
  fatherDirData,
  runtime,
  props,
  emitter,
  dirChildRendered,
  dirChildShow,
  trackCount,
  warnAcoustIdMissing,
  startRename
}: UseLibraryContextMenuOptions) {
  const rightClickMenuShow = ref(false)
  const buildMenuArr = () => {
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      return [
        [{ menuName: 'recycleBin.permanentlyDelete' }],
        [{ menuName: 'tracks.showInFileExplorer' }],
        [{ menuName: 'tracks.convertFormat' }]
      ]
    }
    if (dirData.type === 'dir') {
      if (runtime.libraryAreaSelected === 'MixtapeLibrary') {
        return [
          [{ menuName: 'library.createMixtape' }, { menuName: 'library.createFolder' }],
          [{ menuName: 'common.rename' }, { menuName: 'common.delete' }]
        ]
      }
      return [
        [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
        [{ menuName: 'common.rename' }, { menuName: 'common.delete' }]
      ]
    }
    if (dirData.type === 'mixtapeList') {
      return [
        [{ menuName: 'playlist.autoMix' }],
        [{ menuName: 'common.rename' }, { menuName: 'playlist.deletePlaylist' }]
      ]
    }
    return [
      [{ menuName: 'tracks.importTracks' }, { menuName: 'tracks.exportTracks' }],
      [
        { menuName: 'common.rename' },
        { menuName: 'playlist.deletePlaylist' },
        { menuName: 'playlist.emptyPlaylist' }
      ],
      [{ menuName: 'tracks.showInFileExplorer' }],
      [{ menuName: 'metadata.autoFillMenu' }],
      [{ menuName: 'playlist.clearCache' }],
      [{ menuName: 'playlist.fingerprintDeduplicate' }],
      [{ menuName: 'tracks.convertFormat' }],
      [{ menuName: 'fingerprints.analyzeAndAdd' }]
    ]
  }

  const menuArr = ref<any[][]>(buildMenuArr())

  const deleteDir = async () => {
    if (dirData?.type === 'mixtapeList') {
      const allowed = await libraryUtils.ensureMixtapeDeleteAllowed(props.uuid)
      if (!allowed) return
    }
    const libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    const uuids = libraryUtils.getAllUuids(libraryTree)
    if (uuids.indexOf(runtime.songsArea.songListUUID) !== -1) {
      runtime.songsArea.songListUUID = ''
    }
    if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
    if (!Array.isArray(fatherDirData.children)) {
      throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
    }
    let deleteIndex: number | undefined
    for (const index in fatherDirData.children) {
      if (fatherDirData.children[index]?.uuid === dirData.uuid) {
        deleteIndex = Number(index)
        continue
      }
      if (fatherDirData.children[index].order && dirData.order) {
        if (fatherDirData.children[index].order > dirData.order) {
          fatherDirData.children[index].order--
        }
      }
    }
    if (deleteIndex !== undefined) {
      fatherDirData.children.splice(deleteIndex, 1)
    }
    await libraryUtils.diffLibraryTreeExecuteFileOperation()
  }

  const confirmTaskBusy = async () => {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
  }

  const contextmenuEvent = async (event: MouseEvent) => {
    const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
    const isSongListPathExist = await window.electron.ipcRenderer.invoke(
      'dirPathExists',
      songListPath
    )
    if (!isSongListPathExist) {
      await confirm({
        title: t('common.error'),
        content: [t('library.notExistOnDisk')],
        confirmShow: false
      })
      deleteDir()
      return
    }
    menuArr.value = buildMenuArr()
    rightClickMenuShow.value = true
    const result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
    rightClickMenuShow.value = false
    if (result === 'cancel') return

    switch (result.menuName) {
      case 'library.createPlaylist': {
        dirChildRendered.value = true
        dirChildShow.value = true
        const newUuid = uuidV4()
        dirData.children = dirData.children || []
        dirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'songList'
        })
        runtime.songsArea.songListUUID = newUuid
        break
      }
      case 'library.createMixtape': {
        dirChildRendered.value = true
        dirChildShow.value = true
        const newUuid = uuidV4()
        dirData.children = dirData.children || []
        dirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'mixtapeList'
        })
        runtime.songsArea.songListUUID = newUuid
        break
      }
      case 'library.createFolder': {
        dirChildRendered.value = true
        dirChildShow.value = true
        dirData.children = dirData.children || []
        dirData.children.unshift({
          uuid: uuidV4(),
          dirName: '',
          type: 'dir'
        })
        break
      }
      case 'common.rename': {
        await startRename()
        break
      }
      case 'common.delete':
      case 'playlist.deletePlaylist': {
        await deleteDir()
        break
      }
      case 'playlist.emptyPlaylist': {
        const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        await window.electron.ipcRenderer.invoke('emptyDir', dirPath)
        if (dirData.type === 'songList' && runtime.setting.showPlaylistTrackCount) {
          trackCount.value = 0
        }
        try {
          emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
        } catch {}
        if (runtime.songsArea.songListUUID === props.uuid) {
          runtime.playingData.playingSongListData = []
          runtime.playingData.playingSong = null
          runtime.songsArea.selectedSongFilePath.length = 0
          runtime.songsArea.songInfoArr = []
          runtime.songsArea.totalSongCount = 0
        }
        break
      }
      case 'tracks.importTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        await scanNewSongDialog({ libraryName: props.libraryName, songListUuid: props.uuid })
        break
      }
      case 'tracks.exportTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const dialogResult = await exportDialog({ title: 'tracks.title' })
        if (dialogResult !== 'cancel') {
          const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
          await window.electron.ipcRenderer.invoke(
            'exportSongListToDir',
            dialogResult.folderPathVal,
            dialogResult.deleteSongsAfterExport,
            dirPath
          )
          if (dialogResult.deleteSongsAfterExport) {
            if (runtime.songsArea.songListUUID === props.uuid) {
              runtime.songsArea.songListUUID = ''
            }
            if (runtime.playingData.playingSongListUUID === props.uuid) {
              runtime.playingData.playingSongListUUID = ''
              runtime.playingData.playingSongListData = []
              runtime.playingData.playingSong = null
            }
          }
        }
        break
      }
      case 'playlist.autoMix': {
        if (dirData.type !== 'mixtapeList') break
        const playlistPath = libraryUtils.findDirPathByUuid(props.uuid)
        window.electron.ipcRenderer.send('mixtape:open', {
          playlistId: props.uuid,
          playlistPath,
          playlistName: dirData?.dirName
        })
        break
      }
      case 'tracks.showInFileExplorer': {
        window.electron.ipcRenderer.send(
          'openFileExplorer',
          libraryUtils.findDirPathByUuid(props.uuid)
        )
        break
      }
      case 'metadata.autoFillMenu': {
        const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, props.uuid)
        const files: string[] = Array.isArray(scan?.scanData)
          ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
          : []
        if (!files.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('metadata.autoFillNoEligible')],
            confirmShow: false
          })
          return
        }
        warnAcoustIdMissing()
        runtime.isProgressing = true
        let summary: IMetadataAutoFillSummary | null = null
        let hadError = false
        try {
          summary = await invokeMetadataAutoFill(files)
        } catch (error: any) {
          hadError = true
          const message =
            typeof error?.message === 'string' && error.message.trim().length
              ? error.message
              : t('common.unknownError')
          await confirm({
            title: t('common.error'),
            content: [message],
            confirmShow: false
          })
        } finally {
          runtime.isProgressing = false
        }
        if (!summary) {
          if (!hadError) {
            await confirm({
              title: t('dialog.hint'),
              content: [t('metadata.autoFillNoEligible')],
              confirmShow: false
            })
          }
          return
        }
        const { default: openAutoSummary } = await import(
          '@renderer/components/autoMetadataSummaryDialog'
        )
        await openAutoSummary(summary)
        const updates =
          summary.items
            ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
            .map((item) => ({
              song: item.updatedSongInfo,
              oldFilePath: item.oldFilePath
            })) || []
        if (updates.length) {
          try {
            emitter.emit('metadataBatchUpdated', { updates })
          } catch {}
        }
        if (runtime.songsArea.songListUUID === props.uuid) {
          try {
            emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
          } catch {}
        }
        break
      }
      case 'tracks.convertFormat': {
        try {
          const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
          const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, props.uuid)
          const files: string[] = Array.isArray(scan?.scanData)
            ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
            : []
          if (files.length === 0) return
          const sourceExts = Array.from(
            new Set(
              files
                .map((p) => (p || '').toLowerCase())
                .map((p) => p.match(/\.[^\\\/\.]+$/)?.[0] || '')
                .filter((e) => runtime.setting.audioExt.includes(e))
            )
          )
          const { default: openConvertDialog } = await import(
            '@renderer/components/audioConvertDialog'
          )
          const dialogResult: any = await openConvertDialog({ sourceExts })
          if (dialogResult && dialogResult !== 'cancel') {
            await window.electron.ipcRenderer.invoke('audio:convert:start', {
              files,
              options: dialogResult,
              songListUUID: props.uuid
            })
          }
        } catch {}
        break
      }
      case 'fingerprints.analyzeAndAdd': {
        const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, props.uuid)
        const files: string[] = Array.isArray(scan?.scanData)
          ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
          : []
        if (!files.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('fingerprints.noEligibleTracks')],
            confirmShow: false
          })
          return
        }
        await analyzeFingerprintsForPaths(files, { origin: 'playlist' })
        break
      }
      case 'playlist.clearCache': {
        const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        await window.electron.ipcRenderer.invoke('playlist:cache:clear', dirPath || '')
        trackCount.value = null
        try {
          emitter.emit('playlistCacheCleared', { uuid: props.uuid })
        } catch {}
        break
      }
      case 'playlist.fingerprintDeduplicate': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const confirmResult = await confirm({
          title: t('playlist.deduplicateConfirmTitle'),
          content: [t('playlist.deduplicateConfirm')]
        })
        if (confirmResult !== 'confirm') {
          return
        }
        runtime.isProgressing = true
        const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
        const progressId = `playlist_dedup_${Date.now()}`
        const normalizePath = (p: string | undefined | null) =>
          (p || '').replace(/\//g, '\\').toLowerCase()
        try {
          const summary: any = await window.electron.ipcRenderer.invoke(
            'deduplicateSongListByFingerprint',
            {
              songListPath,
              progressId
            }
          )
          const removedRaw: string[] = Array.isArray(summary?.removedFilePaths)
            ? summary.removedFilePaths.filter(Boolean)
            : []
          const removedNormalized = removedRaw.map((p) => normalizePath(p)).filter(Boolean)
          if (removedNormalized.length > 0) {
            emitter.emit('songsRemoved', { listUUID: props.uuid, paths: removedNormalized })
          }
          try {
            emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
          } catch {}
          const modeLabel =
            summary?.fingerprintMode === 'file'
              ? t('fingerprints.modeFile')
              : t('fingerprints.modePCM')
          const feedbackLines = [
            t('playlist.deduplicateRemovedCount', { n: removedRaw.length }),
            t('playlist.deduplicateModeUsed', { mode: modeLabel })
          ]
          if (summary?.analyzeFailedCount) {
            feedbackLines.push(
              t('import.analysisFailedCount', { count: summary.analyzeFailedCount })
            )
          }
          if (summary?.scannedCount !== undefined) {
            feedbackLines.unshift(
              t('playlist.deduplicateScannedCount', { n: summary.scannedCount || 0 })
            )
          }
          await confirm({
            title: t('playlist.deduplicateFinished'),
            content: feedbackLines,
            confirmShow: false
          })
        } catch (error: any) {
          const message = error?.message ? String(error.message) : '发生未知错误'
          await confirm({
            title: t('common.error'),
            content: [message],
            confirmShow: false
          })
        } finally {
          runtime.isProgressing = false
        }
        break
      }
      case 'recycleBin.permanentlyDelete': {
        const res = await confirm({
          title: t('common.delete'),
          content: [t('tracks.confirmDelete'), t('tracks.deleteHint')]
        })
        if (res === 'confirm') {
          const recycleBin = runtime.libraryTree.children?.find(
            (item: any) => item.dirName === 'RecycleBin'
          )
          const index = recycleBin?.children?.findIndex((item: any) => item.uuid === props.uuid)
          if (index !== undefined && index !== -1 && recycleBin?.children) {
            recycleBin.children.splice(index, 1)
          }
          if (runtime.playingData.playingSongListUUID === props.uuid) {
            runtime.playingData.playingSongListUUID = ''
            runtime.playingData.playingSongListData = []
            runtime.playingData.playingSong = null
          }
          if (runtime.songsArea.songListUUID === props.uuid) {
            runtime.songsArea.selectedSongFilePath.length = 0
            runtime.songsArea.songInfoArr = []
            runtime.songsArea.totalSongCount = 0
          }
          await libraryUtils.diffLibraryTreeExecuteFileOperation()
        }
        break
      }
    }
  }

  return {
    rightClickMenuShow,
    menuArr,
    contextmenuEvent,
    deleteDir
  }
}
