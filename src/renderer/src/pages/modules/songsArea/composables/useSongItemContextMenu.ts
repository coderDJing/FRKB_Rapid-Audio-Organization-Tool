import { nextTick, Ref, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ISongInfo, IMenu } from '../../../../../../types/globals' // Corrected path
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import rightClickMenu from '@renderer/components/rightClickMenu' // Assuming it\'s a default export or easily callable
import confirm from '@renderer/components/confirmDialog'
import exportDialog from '@renderer/components/exportDialog'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// Type for the return value when a dialog needs to be opened by the parent
export interface OpenDialogAction {
  action: 'openSelectSongListDialog'
  libraryName: '精选库' | '筛选库'
}

// 新增：用于表示歌曲被右键菜单操作移除的返回类型
export interface SongsRemovedAction {
  action: 'songsRemoved'
  paths: string[]
}

export function useSongItemContextMenu(
  // runtimeStore: ReturnType<typeof useRuntimeStore>, // Passed implicitly via direct import for now
  songsAreaHostElementRef: Ref<InstanceType<typeof OverlayScrollbarsComponent> | null> // For scrolling
) {
  const runtime = useRuntimeStore() // Use the store directly

  const menuArr: Ref<IMenu[][]> = ref([
    [{ menuName: '导出曲目' }],
    [{ menuName: '移动到筛选库' }, { menuName: '移动到精选库' }],
    [{ menuName: '删除曲目', shortcutKey: 'Delete' }, { menuName: '删除上方所有曲目' }],
    [{ menuName: '在文件资源浏览器中显示' }]
  ])

  const showAndHandleSongContextMenu = async (
    event: MouseEvent,
    song: ISongInfo
  ): Promise<OpenDialogAction | SongsRemovedAction | null> => {
    if (runtime.songsArea.selectedSongFilePath.indexOf(song.filePath) === -1) {
      runtime.songsArea.selectedSongFilePath = [song.filePath]
    }

    const result = await rightClickMenu({
      menuArr: menuArr.value,
      clickEvent: event
    })

    if (result === 'cancel') return null

    switch (result.menuName) {
      case '删除上方所有曲目': {
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
          ?.find((item) => item.dirName === '回收站')
          ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

        if (isInRecycleBin) {
          const res = await confirm({
            title: '删除',
            content: [
              t('确定彻底删除此曲目上方的所有曲目吗'),
              t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
            ]
          })
          if (res !== 'confirm') {
            return null
          }
        }

        // 3. 释放封面URL (基于快照中识别的待删除歌曲对象)
        for (const sInfo of songsToRemoveInfoBasedOnSnapshot) {
          if (sInfo.coverUrl) {
            URL.revokeObjectURL(sInfo.coverUrl)
          }
        }

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
        return { action: 'songsRemoved', paths: delPaths }
      }
      case '删除曲目':
        {
          const currentSelectedPaths = [...runtime.songsArea.selectedSongFilePath]

          if (!currentSelectedPaths.length) return null

          const isInRecycleBin = runtime.libraryTree.children
            ?.find((item) => item.dirName === '回收站')
            ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

          let shouldDelete = true
          if (isInRecycleBin) {
            const res = await confirm({
              title: '删除',
              content: [
                t('确定彻底删除选中的曲目吗'),
                t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
              ]
            })
            shouldDelete = res === 'confirm'
          }

          if (shouldDelete) {
            const songsActuallyBeingDeletedBasedOnSnapshot = runtime.songsArea.songInfoArr.filter(
              (item) => currentSelectedPaths.includes(item.filePath)
            )
            for (const item of songsActuallyBeingDeletedBasedOnSnapshot) {
              if (item.coverUrl) URL.revokeObjectURL(item.coverUrl)
            }

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
            return { action: 'songsRemoved', paths: currentSelectedPaths }
          }
        }
        break
      case '移动到精选库':
        return { action: 'openSelectSongListDialog', libraryName: '精选库' }
      case '移动到筛选库':
        return { action: 'openSelectSongListDialog', libraryName: '筛选库' }
      case '导出曲目': {
        const exportResult = await exportDialog({ title: '曲目' })
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
            for (const songObj of songsToExportObjects) {
              if (songObj.coverUrl) URL.revokeObjectURL(songObj.coverUrl)
            }
            runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
              (item) => !songsToExportFilePaths.includes(item.filePath)
            )
            runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
              (path) => !songsToExportFilePaths.includes(path)
            )

            if (runtime.songsArea.songListUUID === runtime.playingData.playingSongListUUID) {
              runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
              if (
                runtime.playingData.playingSong &&
                songsToExportFilePaths.includes(runtime.playingData.playingSong.filePath)
              ) {
                runtime.playingData.playingSong = null
              }
            }
            return { action: 'songsRemoved', paths: songsToExportFilePaths }
          }
        }
        break
      }
      case '在文件资源浏览器中显示':
        window.electron.ipcRenderer.send('show-item-in-folder', song.filePath)
        break
    }
    return null // Default return if no dialog action
  }

  return {
    showAndHandleSongContextMenu
    // menuArr is not returned as it\'s internal to the composable now
  }
}
