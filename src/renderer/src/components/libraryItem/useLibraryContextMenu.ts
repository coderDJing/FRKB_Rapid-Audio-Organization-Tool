import { ref, type Ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import exportDialog from '@renderer/components/exportDialog'
import { openRekordboxDesktopPlaylistForPlaylist } from '@renderer/utils/rekordboxDesktopPlaylist'
import { openRekordboxXmlExportForPlaylist } from '@renderer/utils/rekordboxXmlExport'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'
import { DEFAULT_MIXTAPE_STEM_PROFILE } from '@shared/mixtapeStemProfiles'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import { setPendingMixtapeProjectMode } from '@renderer/composables/mixtape/stemMode'
import {
  collectFilesForAudioConvert,
  startAudioConvertFromFiles
} from '@renderer/utils/audioConvertActions'
import {
  clearSongsAreaPaneBySongListUUID,
  showSongListInPane
} from '@renderer/utils/songsAreaSplit'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IDir, IMenu, IMetadataAutoFillSummary } from '../../../../types/globals'

type ScanSongListResult = {
  scanData?: Array<{ filePath?: string }>
}

type PlaylistDedupSummary = {
  removedFilePaths?: string[]
  fingerprintMode?: 'pcm' | 'file'
  analyzeFailedCount?: number
  scannedCount?: number
}

type LibraryItemEmitter = {
  emit: (event: string, payload?: unknown) => void
}

interface UseLibraryContextMenuOptions {
  dirDataRef: Ref<IDir | null>
  fatherDirDataRef: Ref<IDir | null>
  runtime: ReturnType<typeof useRuntimeStore>
  props: { uuid: string; libraryName: string }
  emitter: LibraryItemEmitter
  dirChildRendered: { value: boolean }
  dirChildShow: { value: boolean }
  trackCount: { value: number | null }
  warnAcoustIdMissing: () => void
  startRename: () => Promise<void> | void
}

export function useLibraryContextMenu({
  dirDataRef,
  fatherDirDataRef,
  runtime,
  props,
  emitter,
  dirChildRendered,
  dirChildShow,
  trackCount,
  warnAcoustIdMissing,
  startRename
}: UseLibraryContextMenuOptions) {
  const getErrorMessage = (error: unknown) =>
    error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
  const getDirData = () => dirDataRef.value
  const getFatherDirData = () => fatherDirDataRef.value

  const rightClickMenuShow = ref(false)
  const buildMenuArr = (): IMenu[][] => {
    const dirData = getDirData()
    if (!dirData) return []
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      return [
        [{ menuName: 'recycleBin.permanentlyDelete' }],
        [{ menuName: 'tracks.showInFileExplorer' }],
        [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.convertNonMp3ToMp3' }]
      ]
    }
    if (dirData.type === 'dir') {
      if (runtime.libraryAreaSelected === 'MixtapeLibrary') {
        return [
          [
            { menuName: 'library.createStemMixtape' },
            { menuName: 'library.createEqMixtape' },
            { menuName: 'library.createFolder' }
          ],
          [{ menuName: 'common.rename' }, { menuName: 'common.delete' }]
        ]
      }
      return [
        [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
        [{ menuName: 'common.rename' }, { menuName: 'common.delete' }],
        [{ menuName: 'playlist.batchRename' }]
      ]
    }
    if (dirData.type === 'mixtapeList') {
      return [
        [{ menuName: 'playlist.autoMix' }],
        [{ menuName: 'common.rename' }, { menuName: 'playlist.deletePlaylist' }]
      ]
    }
    return [
      [
        { menuName: 'tracks.importTracks' },
        { menuName: 'tracks.exportTracks' },
        { menuName: 'rekordboxDesktop.menuCreatePlaylistFromPlaylist' },
        { menuName: 'rekordboxXmlExport.menuExportPlaylist' }
      ],
      [{ menuName: 'playlist.showInLeftPane' }, { menuName: 'playlist.showInRightPane' }],
      [
        { menuName: 'common.rename' },
        { menuName: 'playlist.deletePlaylist' },
        { menuName: 'playlist.emptyPlaylist' }
      ],
      [{ menuName: 'tracks.showInFileExplorer' }],
      [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'playlist.batchRename' }],
      [{ menuName: 'playlist.fingerprintDeduplicate' }],
      [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.convertNonMp3ToMp3' }],
      [{ menuName: 'fingerprints.analyzeAndAdd' }]
    ]
  }

  const menuArr = ref<IMenu[][]>(buildMenuArr())

  const collectSongListTargets = (
    root: IDir
  ): Array<{ uuid: string; path: string; name: string }> => {
    const result: Array<{ uuid: string; path: string; name: string }> = []
    const traverse = (node: IDir) => {
      if (node.type === 'songList') {
        result.push({
          uuid: node.uuid,
          path: libraryUtils.findDirPathByUuid(node.uuid),
          name: node.dirName
        })
      }
      if (Array.isArray(node.children)) {
        node.children.forEach((child) => traverse(child))
      }
    }
    traverse(root)
    return result
  }

  const deleteDir = async () => {
    if (runtime.isProgressing) {
      await confirmTaskBusy()
      return
    }
    const dirData = getDirData()
    const fatherDirData = getFatherDirData()
    if (!dirData || !fatherDirData) return
    runtime.isProgressing = true
    try {
      if (dirData?.type === 'mixtapeList') {
        const allowed = await libraryUtils.ensureMixtapeDeleteAllowed(props.uuid)
        if (!allowed) return
      }
      const libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
      if (libraryTree === null) {
        throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
      }
      const uuids = libraryUtils.getAllUuids(libraryTree)
      for (const pane of ['single', 'left', 'right'] as const) {
        const paneSongListUUID = runtime.songsAreaPanels.panes[pane].songListUUID
        if (uuids.indexOf(paneSongListUUID) !== -1) {
          runtime.clearSongsAreaPaneState(pane)
        }
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
    } finally {
      runtime.isProgressing = false
    }
  }

  const confirmTaskBusy = async () => {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
  }

  const contextmenuEvent = async (event: MouseEvent) => {
    const dirData = getDirData()
    if (!dirData) return
    const shouldSkipPathCheck =
      dirData.dirName === '' || runtime.creatingSongListUUID === props.uuid
    if (!shouldSkipPathCheck) {
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
        await deleteDir()
        return
      }
    }
    menuArr.value = buildMenuArr()
    if (!menuArr.value.length) return
    rightClickMenuShow.value = true
    const result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
    rightClickMenuShow.value = false
    if (result === 'cancel') return

    switch (result.menuName) {
      case 'library.createPlaylist': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        dirChildRendered.value = true
        dirChildShow.value = true
        const newUuid = uuidV4()
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'songList'
        })
        runtime.songsArea.songListUUID = newUuid
        break
      }
      case 'library.createStemMixtape':
      case 'library.createEqMixtape': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        const mixMode = result.menuName === 'library.createEqMixtape' ? 'eq' : 'stem'
        dirChildRendered.value = true
        dirChildShow.value = true
        const newUuid = uuidV4()
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'mixtapeList',
          mixMode,
          stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
        })
        setPendingMixtapeProjectMode(newUuid, {
          mixMode,
          stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
        })
        runtime.songsArea.songListUUID = newUuid
        break
      }
      case 'library.createFolder': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        dirChildRendered.value = true
        dirChildShow.value = true
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
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
        if (getDirData()?.type === 'songList' && runtime.setting.showPlaylistTrackCount) {
          trackCount.value = 0
        }
        try {
          emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
        } catch {}
        for (const pane of ['single', 'left', 'right'] as const) {
          const paneState = runtime.songsAreaPanels.panes[pane]
          if (paneState.songListUUID === props.uuid) {
            paneState.selectedSongFilePath.length = 0
            paneState.songInfoArr = []
            paneState.totalSongCount = 0
          }
        }
        if (runtime.playingData.playingSongListUUID === props.uuid) {
          runtime.playingData.playingSongListData = []
          runtime.playingData.playingSong = null
        }
        break
      }
      case 'playlist.showInLeftPane': {
        showSongListInPane(runtime, 'left', props.uuid)
        break
      }
      case 'playlist.showInRightPane': {
        showSongListInPane(runtime, 'right', props.uuid)
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
            clearSongsAreaPaneBySongListUUID(runtime, props.uuid)
            if (runtime.playingData.playingSongListUUID === props.uuid) {
              runtime.playingData.playingSongListUUID = ''
              runtime.playingData.playingSongListData = []
              runtime.playingData.playingSong = null
            }
          }
        }
        break
      }
      case 'rekordboxXmlExport.menuExportPlaylist': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
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
        const currentDirData = getDirData()
        const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
        runtime.isProgressing = true
        try {
          const summary = await openRekordboxXmlExportForPlaylist({
            sourceLibraryName: props.libraryName,
            songListUUID: props.uuid,
            songListPath,
            playlistName: String(currentDirData?.dirName || '').trim()
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
        break
      }
      case 'rekordboxDesktop.menuCreatePlaylistFromPlaylist': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const currentDirData = getDirData()
        const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
        runtime.isProgressing = true
        try {
          const summary = await openRekordboxDesktopPlaylistForPlaylist({
            songListUUID: props.uuid,
            songListPath,
            playlistName: String(currentDirData?.dirName || '').trim(),
            deletePayload: {
              songListPath
            }
          })
          if (summary?.removedSourceFilePaths?.length) {
            const removedAll = summary.removedSourceFilePaths.length >= summary.trackCount
            if (!removedAll) {
              try {
                emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
              } catch {}
              break
            }
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
        break
      }
      case 'playlist.autoMix': {
        const currentDirData = getDirData()
        if (currentDirData?.type !== 'mixtapeList') break
        const playlistPath = libraryUtils.findDirPathByUuid(props.uuid)
        window.electron.ipcRenderer.send('mixtape:open', {
          playlistId: props.uuid,
          playlistPath,
          playlistName: currentDirData?.dirName
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
        const scan = (await window.electron.ipcRenderer.invoke(
          'scanSongList',
          dirPath,
          props.uuid
        )) as ScanSongListResult | null
        const files: string[] = Array.isArray(scan?.scanData)
          ? scan.scanData.map((s) => s.filePath).filter((item): item is string => !!item)
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
        } catch (error: unknown) {
          hadError = true
          await confirm({
            title: t('common.error'),
            content: [getErrorMessage(error)],
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
        if (
          (['single', 'left', 'right'] as const).some(
            (pane) => runtime.songsAreaPanels.panes[pane].songListUUID === props.uuid
          )
        ) {
          try {
            emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
          } catch {}
        }
        break
      }
      case 'playlist.batchRename': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const rootNode = libraryUtils.getLibraryTreeByUUID(props.uuid)
        if (!rootNode) {
          return
        }
        const songLists =
          rootNode.type === 'songList'
            ? [
                {
                  uuid: rootNode.uuid,
                  path: libraryUtils.findDirPathByUuid(rootNode.uuid),
                  name: rootNode.dirName
                }
              ]
            : collectSongListTargets(rootNode)
        if (!songLists.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('batchRename.noEligibleTracks')],
            confirmShow: false
          })
          return
        }
        const { default: openPlaylistBatchRenameDialog } = await import(
          '@renderer/components/playlistBatchRename'
        )
        await openPlaylistBatchRenameDialog({
          title: t('batchRename.dialogTitle'),
          songLists
        })
        break
      }
      case 'tracks.convertFormat': {
        try {
          const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
          const files = await collectFilesForAudioConvert([
            {
              songListPath: dirPath,
              songListUUID: props.uuid
            }
          ])
          await startAudioConvertFromFiles({
            files,
            allowedSourceExts: runtime.setting.audioExt,
            songListUUID: props.uuid
          })
        } catch {}
        break
      }
      case 'tracks.convertNonMp3ToMp3': {
        try {
          const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
          const files = await collectFilesForAudioConvert([
            {
              songListPath: dirPath,
              songListUUID: props.uuid
            }
          ])
          const result = await startAudioConvertFromFiles({
            files,
            allowedSourceExts: runtime.setting.audioExt,
            songListUUID: props.uuid,
            presetTargetFormat: 'mp3',
            lockTargetFormat: true,
            excludeSameFormatAsTarget: true,
            skipExistingTargetCopies: true
          })
          if (result.status === 'no-files') {
            await confirm({
              title: t('dialog.hint'),
              content: [t('convert.noNonMp3Files')],
              confirmShow: false
            })
          }
        } catch {}
        break
      }
      case 'fingerprints.analyzeAndAdd': {
        const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        const scan = (await window.electron.ipcRenderer.invoke(
          'scanSongList',
          dirPath,
          props.uuid
        )) as ScanSongListResult | null
        const files: string[] = Array.isArray(scan?.scanData)
          ? scan.scanData.map((s) => s.filePath).filter((item): item is string => !!item)
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
          const summary = (await window.electron.ipcRenderer.invoke(
            'deduplicateSongListByFingerprint',
            {
              songListPath,
              progressId
            }
          )) as PlaylistDedupSummary
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
        } catch (error: unknown) {
          await confirm({
            title: t('common.error'),
            content: [getErrorMessage(error)],
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
            (item) => item.dirName === 'RecycleBin'
          )
          const index = recycleBin?.children?.findIndex((item) => item.uuid === props.uuid)
          if (index !== undefined && index !== -1 && recycleBin?.children) {
            recycleBin.children.splice(index, 1)
          }
          if (runtime.playingData.playingSongListUUID === props.uuid) {
            runtime.playingData.playingSongListUUID = ''
            runtime.playingData.playingSongListData = []
            runtime.playingData.playingSong = null
          }
          clearSongsAreaPaneBySongListUUID(runtime, props.uuid)
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
