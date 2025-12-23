import { nextTick, Ref, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ISongInfo, IMenu, type IMetadataAutoFillSummary } from '../../../../../../types/globals'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import rightClickMenu from '@renderer/components/rightClickMenu'
import confirm from '@renderer/components/confirmDialog'
import exportDialog from '@renderer/components/exportDialog'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import emitter from '@renderer/utils/mitt'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'

const debugSelection = (...args: any[]) => {
  try {
    const isDev =
      typeof window !== 'undefined' &&
      typeof window.location?.protocol === 'string' &&
      (window.location.protocol === 'http:' || window.location.hostname === 'localhost')
    const forced =
      typeof window !== 'undefined' &&
      typeof window.localStorage?.getItem === 'function' &&
      window.localStorage.getItem('FRKB_DEBUG_SELECTION') === '1'
    if (isDev || forced) {
      console.log(...args)
    }
  } catch {}
}

// Type for the return value when a dialog needs to be opened by the parent
export interface OpenDialogAction {
  action: 'openSelectSongListDialog'
  libraryName: 'CuratedLibrary' | 'FilterLibrary'
}

// 新增：用于表示歌曲被右键菜单操作移除的返回类型
export interface SongsRemovedAction {
  action: 'songsRemoved'
  paths: string[]
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

export interface SelectionLabelsChangedAction {
  action: 'selectionLabelsChanged'
  filePaths: string[]
  label: 'liked' | 'disliked' | 'neutral'
}

export function useSongItemContextMenu(
  // runtimeStore: ReturnType<typeof useRuntimeStore>, // Passed implicitly via direct import for now
  songsAreaHostElementRef: Ref<InstanceType<typeof OverlayScrollbarsComponent> | null> // For scrolling
) {
  const runtime = useRuntimeStore() // Use the store directly
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

  const menuArr: Ref<IMenu[][]> = ref([
    [{ menuName: 'tracks.exportTracks' }],
    [{ menuName: 'library.moveToFilter' }, { menuName: 'library.moveToCurated' }],
    [
      { menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' },
      { menuName: 'tracks.deleteAllAbove' }
    ],
    [{ menuName: 'tracks.showInFileExplorer' }],
    [{ menuName: 'metadata.autoFillMenu' }],
    [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.editMetadata' }],
    [
      { menuName: 'selection.like' },
      { menuName: 'selection.dislike' },
      { menuName: 'selection.clearPreference' }
    ],
    [{ menuName: 'tracks.clearTrackCache' }],
    [{ menuName: 'fingerprints.analyzeAndAdd' }]
  ])

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
    | SelectionLabelsChangedAction
    | null
  > => {
    if (runtime.songsArea.selectedSongFilePath.indexOf(song.filePath) === -1) {
      runtime.songsArea.selectedSongFilePath = [song.filePath]
    }

    const result = await rightClickMenu({
      menuArr: menuArr.value,
      clickEvent: event
    })

    if (result === 'cancel') return null

    switch (result.menuName) {
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
        const selectedFiles = [...runtime.songsArea.selectedSongFilePath]
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
        const files = [...runtime.songsArea.selectedSongFilePath]
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
        const isInRecycleBin = runtime.libraryTree.children
          ?.find((item) => item.dirName === 'RecycleBin')
          ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

        if (isInRecycleBin) {
          const res = await confirm({
            title: t('common.delete'),
            content: [t('tracks.confirmDeleteAllAbove'), t('tracks.deleteHint')]
          })
          if (res !== 'confirm') {
            return null
          }
        }

        // 列表不再使用封面 URL，无需回收

        // 4. IPC 调用执行文件删除
        if (isInRecycleBin) {
          await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [...delPaths])
        } else {
          window.electron.ipcRenderer.send('delSongs', [...delPaths], getCurrentTimeDirName())
        }

        // 7. UI 操作 (滚动到顶部)
        nextTick(() => {
          const viewport = songsAreaHostElementRef.value?.osInstance()?.elements().viewport
          if (viewport) {
            viewport.scrollTo({ top: 0, behavior: 'smooth' })
          }
        })
        // 通知全局，保证其他视图也能同步（包含当前 songsArea 监听的统一删除处理）
        emitter.emit('songsRemoved', { listUUID: runtime.songsArea.songListUUID, paths: delPaths })
        emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
        return { action: 'songsRemoved', paths: delPaths }
      }
      case 'tracks.deleteTracks':
        {
          const currentSelectedPaths = [...runtime.songsArea.selectedSongFilePath]

          if (!currentSelectedPaths.length) return null

          const isInRecycleBin = runtime.libraryTree.children
            ?.find((item) => item.dirName === 'RecycleBin')
            ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

          let shouldDelete = true
          if (isInRecycleBin) {
            const res = await confirm({
              title: t('common.delete'),
              content: [t('tracks.confirmDeleteSelected'), t('tracks.deleteHint')]
            })
            shouldDelete = res === 'confirm'
          }

          if (shouldDelete) {
            const songsActuallyBeingDeletedBasedOnSnapshot = runtime.songsArea.songInfoArr.filter(
              (item) => currentSelectedPaths.includes(item.filePath)
            )
            // 列表不再使用封面 URL

            if (isInRecycleBin) {
              await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
                ...currentSelectedPaths
              ])
            } else {
              window.electron.ipcRenderer.send(
                'delSongs',
                [...currentSelectedPaths],
                getCurrentTimeDirName()
              )
            }

            runtime.songsArea.selectedSongFilePath.length = 0
            emitter.emit('songsRemoved', {
              listUUID: runtime.songsArea.songListUUID,
              paths: currentSelectedPaths
            })
            emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
            return { action: 'songsRemoved', paths: currentSelectedPaths }
          }
        }
        break
      case 'fingerprints.analyzeAndAdd': {
        const files = [...runtime.songsArea.selectedSongFilePath]
        await analyzeFingerprintsForPaths(files, { origin: 'selection' })
        return null
      }
      case 'selection.like':
      case 'selection.dislike':
      case 'selection.clearPreference': {
        const files = [...runtime.songsArea.selectedSongFilePath]
        if (files.length === 0) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('fingerprints.noTracksSelected')],
            confirmShow: false
          })
          return null
        }

        const label =
          result.menuName === 'selection.like'
            ? 'liked'
            : result.menuName === 'selection.dislike'
              ? 'disliked'
              : 'neutral'

        const startedAt = Date.now()
        debugSelection('[selection] 应用标签：开始', { label, fileCount: files.length })
        try {
          const res = await window.electron.ipcRenderer.invoke('selection:labels:setForFilePaths', {
            filePaths: files,
            label
          })
          const hashReport = Array.isArray(res?.hashReport) ? res.hashReport : []
          const hashOk = hashReport.filter((x: any) => x?.ok === true).length
          const featureQueue = res?.featureQueue || {}
          const featureEnqueued =
            typeof featureQueue?.enqueued === 'number' ? featureQueue.enqueued : 0
          const featureSkipped =
            typeof featureQueue?.skipped === 'number' ? featureQueue.skipped : 0

          debugSelection('[selection] 应用标签：返回', {
            ms: Date.now() - startedAt,
            ok: res?.ok === true,
            sampleChangeDelta: res?.labelResult?.sampleChangeDelta,
            sampleChangeCount: res?.labelResult?.sampleChangeCount,
            hashOk,
            hashTotal: hashReport.length,
            featureEnqueued,
            featureSkipped
          })

          if (!res?.ok) {
            throw new Error(res?.failed?.message || res?.failed?.errorCode || 'FAILED')
          }

          return { action: 'selectionLabelsChanged', filePaths: files, label }
        } catch (error: any) {
          await confirm({
            title: t('common.error'),
            content: [String(error?.message || error || t('common.unknownError'))],
            confirmShow: false
          })
        }
        return null
      }
      case 'library.moveToCurated':
        return { action: 'openSelectSongListDialog', libraryName: 'CuratedLibrary' }
      case 'library.moveToFilter':
        return { action: 'openSelectSongListDialog', libraryName: 'FilterLibrary' }
      case 'tracks.exportTracks': {
        const exportResult = await exportDialog({ title: 'tracks.title' })
        if (exportResult !== 'cancel') {
          const { folderPathVal, deleteSongsAfterExport } = exportResult
          const songsToExportFilePaths = [...runtime.songsArea.selectedSongFilePath]

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
            runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
              (path) => !songsToExportFilePaths.includes(path)
            )
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
