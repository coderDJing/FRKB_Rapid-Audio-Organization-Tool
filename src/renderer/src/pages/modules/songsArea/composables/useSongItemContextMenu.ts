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
  ): Promise<OpenDialogAction | null> => {
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
        const delSongs: string[] = []
        for (const item of runtime.songsArea.songInfoArr) {
          if (item.filePath === song.filePath) break
          if (item.coverUrl) URL.revokeObjectURL(item.coverUrl)
          delSongs.push(item.filePath)
        }
        if (delSongs.length === 0) return null

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
          if (res !== 'confirm') return null
        }

        if (isInRecycleBin) {
          window.electron.ipcRenderer.invoke(
            'permanentlyDelSongs',
            JSON.parse(JSON.stringify(delSongs))
          )
        } else {
          window.electron.ipcRenderer.send(
            'delSongs',
            JSON.parse(JSON.stringify(delSongs)),
            getCurrentTimeDirName()
          )
        }

        runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
          (s) => !delSongs.includes(s.filePath)
        )
        if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
          runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
        }
        if (
          runtime.playingData.playingSong &&
          delSongs.includes(runtime.playingData.playingSong.filePath)
        ) {
          runtime.playingData.playingSong = null
        }
        nextTick(() => {
          const viewport = songsAreaHostElementRef.value?.osInstance()?.elements().viewport
          if (viewport) {
            viewport.scrollTo({ top: 0, behavior: 'smooth' })
          } else {
            console.warn(
              'OverlayScrollbars viewport element not available for scrolling in composable.'
            )
          }
        })
        break
      }
      case '删除曲目':
        // This case relies on the deleteSong function which is currently in songsArea.vue
        // For now, we can replicate its core logic or emit an event for parent to handle.
        // Let\'s try to replicate its core logic here, assuming `deleteSong` primarily deals with selected songs.
        {
          const selectedPaths = JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
          if (!selectedPaths.length) return null

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
            if (isInRecycleBin) {
              window.electron.ipcRenderer.invoke('permanentlyDelSongs', selectedPaths)
            } else {
              window.electron.ipcRenderer.send('delSongs', selectedPaths, getCurrentTimeDirName())
            }

            const songsToDeleteFromStore = runtime.songsArea.songInfoArr.filter((item) =>
              selectedPaths.includes(item.filePath)
            )
            for (const item of songsToDeleteFromStore) {
              if (item.coverUrl) URL.revokeObjectURL(item.coverUrl)
            }
            runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
              (item) => !selectedPaths.includes(item.filePath)
            )
            if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
              runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
            }
            if (
              runtime.playingData.playingSong &&
              selectedPaths.includes(runtime.playingData.playingSong.filePath)
            ) {
              runtime.playingData.playingSong = null
            }
            runtime.songsArea.selectedSongFilePath.length = 0
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
          const songsToExport = runtime.songsArea.songInfoArr.filter((item) =>
            runtime.songsArea.selectedSongFilePath.includes(item.filePath)
          )
          await window.electron.ipcRenderer.invoke(
            'exportSongsToDir',
            folderPathVal,
            deleteSongsAfterExport,
            JSON.parse(JSON.stringify(songsToExport))
          )
          if (deleteSongsAfterExport) {
            for (const item of songsToExport) {
              if (item.coverUrl) URL.revokeObjectURL(item.coverUrl)
            }
            runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
              (item) => !runtime.songsArea.selectedSongFilePath.includes(item.filePath)
            )
            runtime.songsArea.selectedSongFilePath = []
            if (runtime.songsArea.songListUUID === runtime.playingData.playingSongListUUID) {
              runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
              if (
                runtime.playingData.playingSong &&
                !runtime.playingData.playingSongListData.some(
                  (item) => item.filePath === runtime.playingData.playingSong?.filePath
                )
              ) {
                runtime.playingData.playingSong = null
              }
            }
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
