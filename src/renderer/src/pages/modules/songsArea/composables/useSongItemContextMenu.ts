import { nextTick, Ref, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ISongInfo, IMenu, type IMetadataAutoFillSummary } from '../../../../../../types/globals' // Corrected path
import { t } from '@renderer/utils/translate'
import rightClickMenu from '@renderer/components/rightClickMenu' // Assuming it's a default export or easily callable
import confirm from '@renderer/components/confirmDialog'
import exportDialog from '@renderer/components/exportDialog'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import emitter from '@renderer/utils/mitt'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import libraryUtils from '@renderer/utils/libraryUtils'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

// Type for the return value when a dialog needs to be opened by the parent
export interface OpenDialogAction {
  action: 'openSelectSongListDialog'
  libraryName: 'CuratedLibrary' | 'FilterLibrary' | 'MixtapeLibrary'
}

// 新增：用于表示歌曲被右键菜单操作移除的返回类型
export interface SongsRemovedAction {
  action: 'songsRemoved'
  paths?: string[]
  itemIds?: string[]
}

export interface MetadataUpdatedAction {
  action: 'metadataUpdated'
  song: ISongInfo
  oldFilePath?: string
}

export interface MetadataBatchUpdatedAction {
  action: 'metadataBatchUpdated'
  updates: Array<{ song: ISongInfo; oldFilePath?: string }>
}

export interface PlaylistCacheClearedAction {
  action: 'playlistCacheCleared'
}

export interface TrackCacheClearedAction {
  action: 'trackCacheCleared'
}

export function useSongItemContextMenu(
  // runtimeStore: ReturnType<typeof useRuntimeStore>, // Passed implicitly via direct import for now
  songsAreaHostElementRef: Ref<InstanceType<typeof OverlayScrollbarsComponent> | null> // For scrolling
) {
  const runtime = useRuntimeStore() // Use the store directly
  const isMixtapeView = () =>
    libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)?.type === 'mixtapeList'
  const getRowKey = (song: ISongInfo) =>
    isMixtapeView() && song.mixtapeItemId ? song.mixtapeItemId : song.filePath
  const resolveSelectedKeys = () => runtime.songsArea.selectedSongFilePath
  const resolveSelectedFilePaths = (keys?: string[]) => {
    const selectedKeys = keys ?? resolveSelectedKeys()
    if (!isMixtapeView()) return selectedKeys
    const map = new Map<string, string>()
    for (const item of runtime.songsArea.songInfoArr) {
      if (item.mixtapeItemId) {
        map.set(item.mixtapeItemId, item.filePath)
      }
    }
    return selectedKeys
      .map((key) => map.get(key) || key)
      .filter((p) => typeof p === 'string' && p.length > 0)
  }
  const resolveSelectedItemIds = (keys?: string[]) => {
    if (!isMixtapeView()) return []
    const selectedKeys = keys ?? resolveSelectedKeys()
    const available = new Set(
      runtime.songsArea.songInfoArr
        .map((item) => item.mixtapeItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
    return selectedKeys.filter((key) => available.has(key))
  }
  const hasAcoustIdKey = () => {
    const key = (runtime.setting?.acoustIdClientKey || '').trim()
    return key.length > 0
  }
  const hasWarnedMissingAcoustId = ref(false)
  const warnAcoustIdMissing = () => {
    if (hasAcoustIdKey() || hasWarnedMissingAcoustId.value) return
    hasWarnedMissingAcoustId.value = true
    void confirm({
      title: t('metadata.autoFillFingerprintHintTitle'),
      content: [
        t('metadata.autoFillFingerprintHintMissing'),
        t('metadata.autoFillFingerprintHintGuide')
      ],
      confirmShow: false
    })
  }

  const defaultMenuArr: IMenu[][] = [
    [{ menuName: 'tracks.exportTracks' }],
    [
      { menuName: 'library.moveToFilter' },
      { menuName: 'library.moveToCurated' },
      { menuName: 'library.addToMixtape' }
    ],
    [
      { menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' },
      { menuName: 'tracks.deleteAllAbove' }
    ],
    [{ menuName: 'tracks.showInFileExplorer' }],
    [{ menuName: 'metadata.autoFillMenu' }],
    [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.editMetadata' }],
    [{ menuName: 'tracks.clearTrackCache' }],
    [{ menuName: 'fingerprints.analyzeAndAdd' }]
  ]
  const recycleMenuArr: IMenu[][] = [
    [{ menuName: 'recycleBin.restoreToOriginal' }],
    [{ menuName: 'tracks.exportTracks' }],
    [{ menuName: 'library.moveToFilter' }, { menuName: 'library.moveToCurated' }],
    [
      { menuName: 'recycleBin.permanentlyDeleteTracks', shortcutKey: 'Delete' },
      { menuName: 'tracks.deleteAllAbove' }
    ],
    [{ menuName: 'tracks.showInFileExplorer' }],
    [{ menuName: 'metadata.autoFillMenu' }],
    [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.editMetadata' }],
    [{ menuName: 'tracks.clearTrackCache' }],
    [{ menuName: 'fingerprints.analyzeAndAdd' }]
  ]
  const mixtapeMenuArr: IMenu[][] = [
    [{ menuName: 'tracks.exportTracks' }],
    [{ menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' }],
    [{ menuName: 'tracks.showInFileExplorer' }],
    [{ menuName: 'tracks.editMetadata' }],
    [{ menuName: 'tracks.clearTrackCache' }]
  ]
  const menuArr: Ref<IMenu[][]> = ref(defaultMenuArr)

  const showAndHandleSongContextMenu = async (
    event: MouseEvent,
    song: ISongInfo
  ): Promise<
    | OpenDialogAction
    | SongsRemovedAction
    | MetadataUpdatedAction
    | MetadataBatchUpdatedAction
    | PlaylistCacheClearedAction
    | TrackCacheClearedAction
    | null
  > => {
    const isRecycleBinView = runtime.songsArea.songListUUID === RECYCLE_BIN_UUID
    const isExternalView = runtime.songsArea.songListUUID === EXTERNAL_PLAYLIST_UUID
    if (runtime.songsArea.selectedSongFilePath.indexOf(getRowKey(song)) === -1) {
      runtime.songsArea.selectedSongFilePath = [getRowKey(song)]
    }

    menuArr.value = isMixtapeView()
      ? mixtapeMenuArr
      : isRecycleBinView
        ? recycleMenuArr
        : defaultMenuArr
    const result = await rightClickMenu({
      menuArr: menuArr.value,
      clickEvent: event
    })

    if (result === 'cancel') return null

    const buildDelSongsPayload = (paths: string[]) => {
      if (isExternalView) {
        return { filePaths: paths, sourceType: 'external' }
      }
      const songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)
      if (songListPath) {
        return { filePaths: paths, songListPath }
      }
      return paths
    }

    const showDeleteSummaryIfNeeded = async (summary: {
      total?: number
      success?: number
      failed?: number
    }) => {
      const total = Number(summary?.total || 0)
      const success = Number(summary?.success || 0)
      const failed = Number(summary?.failed || 0)
      if (total <= 1 && failed === 0) return
      const content: string[] = []
      content.push(t('recycleBin.deleteSummarySuccess', { count: success }))
      if (failed > 0) {
        content.push(t('recycleBin.deleteSummaryFailed', { count: failed }))
      }
      await confirm({
        title: t('recycleBin.deleteSummaryTitle'),
        content,
        confirmShow: false
      })
    }

    const showRestoreSummaryIfNeeded = async (summary: {
      total?: number
      restored?: number
      missingPlaylist?: number
      missingFile?: number
      missingRecord?: number
      failed?: number
    }) => {
      const total = Number(summary?.total || 0)
      const restored = Number(summary?.restored || 0)
      const missingPlaylist = Number(summary?.missingPlaylist || 0)
      const missingFile = Number(summary?.missingFile || 0)
      const missingRecord = Number(summary?.missingRecord || 0)
      const failed = Number(summary?.failed || 0)
      if (
        total <= 1 &&
        missingPlaylist === 0 &&
        missingFile === 0 &&
        missingRecord === 0 &&
        failed === 0
      )
        return
      const content: string[] = []
      content.push(t('recycleBin.restoreSummarySuccess', { count: restored }))
      if (missingPlaylist > 0) {
        content.push(t('recycleBin.restoreSummaryMissingPlaylist', { count: missingPlaylist }))
        content.push(t('recycleBin.restoreMissingPlaylistHint'))
      }
      if (missingFile > 0) {
        content.push(t('recycleBin.restoreSummaryMissingFile', { count: missingFile }))
      }
      if (missingRecord > 0) {
        content.push(t('recycleBin.restoreSummaryMissingRecord', { count: missingRecord }))
      }
      if (failed > 0) {
        content.push(t('recycleBin.restoreSummaryFailed', { count: failed }))
      }
      await confirm({
        title: t('recycleBin.restoreSummaryTitle'),
        content,
        confirmShow: false
      })
    }

    switch (result.menuName) {
      case 'recycleBin.restoreToOriginal': {
        const currentSelectedPaths = resolveSelectedFilePaths()
        if (!currentSelectedPaths.length) return null
        const summary = await window.electron.ipcRenderer.invoke('recycleBin:restore', {
          filePaths: [...currentSelectedPaths]
        })
        const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
        if (removedPaths.length > 0) {
          emitter.emit('songsRemoved', {
            listUUID: runtime.songsArea.songListUUID,
            paths: removedPaths
          })
        }
        const playlistUuids = Array.isArray(summary?.playlistUuids) ? summary.playlistUuids : []
        if (playlistUuids.length > 0) {
          emitter.emit('playlistContentChanged', { uuids: playlistUuids })
        }
        runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
          (path) => !removedPaths.includes(path)
        )
        await showRestoreSummaryIfNeeded(summary)
        if (removedPaths.length > 0) {
          return { action: 'songsRemoved', paths: removedPaths }
        }
        return null
      }
      case 'tracks.editMetadata': {
        const { default: openEditMetadataDialog } = await import(
          '@renderer/components/editMetadataDialog'
        )
        const dialogResult = await openEditMetadataDialog({
          filePath: song.filePath
        })
        if (dialogResult && dialogResult !== 'cancel') {
          return {
            action: 'metadataUpdated',
            song: dialogResult.updatedSongInfo,
            oldFilePath: dialogResult.oldFilePath
          }
        }
        return null
      }
      case 'metadata.autoFillMenu': {
        const selectedFiles = resolveSelectedFilePaths()
        if (!selectedFiles.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('metadata.autoFillNeedSelection')],
            confirmShow: false
          })
          return null
        }
        warnAcoustIdMissing()
        runtime.isProgressing = true
        let summary: IMetadataAutoFillSummary | null = null
        let hadError = false
        try {
          summary = await invokeMetadataAutoFill(selectedFiles)
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
          return null
        }
        const { default: openAutoSummary } = await import(
          '@renderer/components/autoMetadataSummaryDialog'
        )
        await openAutoSummary(summary)
        const updates =
          summary.items
            ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
            .map((item) => ({
              song: item.updatedSongInfo as ISongInfo,
              oldFilePath: item.oldFilePath
            })) || []
        if (updates.length) {
          return {
            action: 'metadataBatchUpdated',
            updates
          }
        }
        return null
      }
      case 'tracks.convertFormat': {
        // 打开转换对话框并获取选项
        const { default: openConvertDialog } = await import(
          '@renderer/components/audioConvertDialog'
        )
        const files = resolveSelectedFilePaths()
        const extsSet = new Set(
          files
            .map((p) => (p || '').toLowerCase())
            .map((p) => p.match(/\.[^\\\/\.]+$/)?.[0] || '')
            .filter((e) => runtime.setting.audioExt.includes(e))
        )
        const sourceExts = Array.from(extsSet)
        const dialogResult: any = await openConvertDialog({ sourceExts })
        if (dialogResult && dialogResult !== 'cancel') {
          try {
            await window.electron.ipcRenderer.invoke('audio:convert:start', {
              files,
              options: dialogResult,
              songListUUID: runtime.songsArea.songListUUID
            })
          } catch (e) {
            // 忽略错误，由主进程统一上报
          }
        }
        return null
      }
      case 'tracks.deleteAllAbove': {
        // 1. 基于当前状态和右键的歌曲，确定要删除的歌曲信息和路径 (delPaths)
        const initialSongInfoArrSnapshot = [...runtime.songsArea.songInfoArr]
        const songIndex = initialSongInfoArrSnapshot.findIndex(
          (item) => item.filePath === song.filePath
        )

        if (songIndex === -1) {
          return null
        }
        if (songIndex === 0) {
          return null // 没有曲目在当前曲目之上
        }

        const songsToRemoveInfoBasedOnSnapshot = initialSongInfoArrSnapshot.slice(0, songIndex)
        const delPaths = songsToRemoveInfoBasedOnSnapshot.map((s) => s.filePath)

        if (delPaths.length === 0) {
          return null
        }

        // 2. 用户确认 (如果需要)
        if (isRecycleBinView) {
          const res = await confirm({
            title: t('common.delete'),
            content: [t('tracks.confirmDeleteAllAbove'), t('tracks.deleteHint')]
          })
          if (res !== 'confirm') {
            return null
          }
        }

        // 列表不再使用封面 URL，无需回收

        let removedPathsForEvent = [...delPaths]
        // 4. IPC 调用执行文件删除
        if (isRecycleBinView) {
          const summary = await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
            ...delPaths
          ])
          const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
          if (removedPaths.length > 0) {
            emitter.emit('songsRemoved', {
              listUUID: runtime.songsArea.songListUUID,
              paths: removedPaths
            })
          }
          removedPathsForEvent = removedPaths
          await showDeleteSummaryIfNeeded(summary)
        } else {
          window.electron.ipcRenderer.send('delSongs', buildDelSongsPayload([...delPaths]))
        }

        // 7. UI 操作 (滚动到顶部)
        nextTick(() => {
          const viewport = songsAreaHostElementRef.value?.osInstance()?.elements().viewport
          if (viewport) {
            viewport.scrollTo({ top: 0, behavior: 'smooth' })
          }
        })
        // 通知全局，保证其他视图也能同步（包含当前 songsArea 监听的统一删除处理）
        emitter.emit('songsRemoved', {
          listUUID: runtime.songsArea.songListUUID,
          paths: removedPathsForEvent
        })
        emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
        return { action: 'songsRemoved', paths: removedPathsForEvent }
      }
      case 'tracks.deleteTracks':
      case 'recycleBin.permanentlyDeleteTracks':
        {
          const currentSelectedKeys = [...resolveSelectedKeys()]

          if (!currentSelectedKeys.length) return null

          if (isMixtapeView()) {
            const itemIds = resolveSelectedItemIds(currentSelectedKeys)
            if (!itemIds.length) return null
            await window.electron.ipcRenderer.invoke('mixtape:remove', {
              playlistId: runtime.songsArea.songListUUID,
              itemIds: [...itemIds]
            })
            runtime.songsArea.selectedSongFilePath.length = 0
            emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
            emitter.emit('songsRemoved', {
              listUUID: runtime.songsArea.songListUUID,
              itemIds: [...itemIds]
            })
            return { action: 'songsRemoved', itemIds: [...itemIds] }
          }

          let shouldDelete = true
          if (isRecycleBinView) {
            const res = await confirm({
              title: t('common.delete'),
              content: [t('tracks.confirmDeleteSelected'), t('tracks.deleteHint')]
            })
            shouldDelete = res === 'confirm'
          }

          if (shouldDelete) {
            const resolvedSelectedPaths = resolveSelectedFilePaths(currentSelectedKeys)
            let removedPathsForEvent = [...resolvedSelectedPaths]
            if (isRecycleBinView) {
              const summary = await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
                ...resolvedSelectedPaths
              ])
              const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
              if (removedPaths.length > 0) {
                emitter.emit('songsRemoved', {
                  listUUID: runtime.songsArea.songListUUID,
                  paths: removedPaths
                })
              }
              removedPathsForEvent = removedPaths
              await showDeleteSummaryIfNeeded(summary)
            } else {
              window.electron.ipcRenderer.send(
                'delSongs',
                buildDelSongsPayload([...resolvedSelectedPaths])
              )
            }

            runtime.songsArea.selectedSongFilePath.length = 0
            emitter.emit('songsRemoved', {
              listUUID: runtime.songsArea.songListUUID,
              paths: removedPathsForEvent
            })
            emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
            return { action: 'songsRemoved', paths: removedPathsForEvent }
          }
        }
        break
      case 'fingerprints.analyzeAndAdd': {
        const files = resolveSelectedFilePaths()
        await analyzeFingerprintsForPaths(files, { origin: 'selection' })
        return null
      }
      case 'library.moveToCurated':
        return { action: 'openSelectSongListDialog', libraryName: 'CuratedLibrary' }
      case 'library.moveToFilter':
        return { action: 'openSelectSongListDialog', libraryName: 'FilterLibrary' }
      case 'library.addToMixtape':
        return { action: 'openSelectSongListDialog', libraryName: 'MixtapeLibrary' }
      case 'tracks.exportTracks': {
        const exportResult = await exportDialog({ title: 'tracks.title' })
        if (exportResult !== 'cancel') {
          const { folderPathVal, deleteSongsAfterExport } = exportResult
          const songsToExportFilePaths = resolveSelectedFilePaths()

          const songsToExportObjects = runtime.songsArea.songInfoArr.filter((item) =>
            songsToExportFilePaths.includes(item.filePath)
          )

          await window.electron.ipcRenderer.invoke(
            'exportSongsToDir',
            folderPathVal,
            deleteSongsAfterExport,
            JSON.parse(JSON.stringify(songsToExportObjects))
          )
          if (deleteSongsAfterExport && songsToExportFilePaths.length > 0) {
            // 不直接修改显示列表，仅广播，由 songsArea.vue 统一处理 original + applyFiltersAndSorting
            if (isMixtapeView()) {
              runtime.songsArea.selectedSongFilePath.length = 0
            } else {
              runtime.songsArea.selectedSongFilePath =
                runtime.songsArea.selectedSongFilePath.filter(
                  (path) => !songsToExportFilePaths.includes(path)
                )
            }
            if (runtime.songsArea.songListUUID === runtime.playingData.playingSongListUUID) {
              if (
                runtime.playingData.playingSong &&
                songsToExportFilePaths.includes(runtime.playingData.playingSong.filePath)
              ) {
                runtime.playingData.playingSong = null
              }
            }
            emitter.emit('songsRemoved', {
              listUUID: runtime.songsArea.songListUUID,
              paths: songsToExportFilePaths
            })
            emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
            return { action: 'songsRemoved', paths: songsToExportFilePaths }
          }
        }
        break
      }
      case 'tracks.showInFileExplorer':
        window.electron.ipcRenderer.send('show-item-in-folder', song.filePath)
        break
      case 'tracks.clearTrackCache': {
        await window.electron.ipcRenderer.invoke('track:cache:clear', song.filePath)
        return { action: 'trackCacheCleared' }
      }
    }
    return null // Default return if no dialog action
  }

  return {
    showAndHandleSongContextMenu
    // menuArr is not returned as it's internal to the composable now
  }
}
