import { onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'

interface UseKeyboardSelectionParams {
  runtime: ReturnType<typeof useRuntimeStore>
  externalViewportHeight: { value: number }
  scheduleSweepCovers: () => void
}

export function useKeyboardSelection(params: UseKeyboardSelectionParams) {
  const { runtime, externalViewportHeight, scheduleSweepCovers } = params

  const songClick = (event: MouseEvent, song: ISongInfo) => {
    runtime.activeMenuUUID = ''
    if (event.ctrlKey) {
      const index = runtime.songsArea.selectedSongFilePath.indexOf(song.filePath)
      if (index !== -1) {
        runtime.songsArea.selectedSongFilePath.splice(index, 1)
      } else {
        runtime.songsArea.selectedSongFilePath.push(song.filePath)
      }
    } else if (event.shiftKey) {
      let lastClickSongFilePath: string | null = null
      if (runtime.songsArea.selectedSongFilePath.length) {
        lastClickSongFilePath =
          runtime.songsArea.selectedSongFilePath[runtime.songsArea.selectedSongFilePath.length - 1]
      }
      let lastClickSongIndex = 0
      if (lastClickSongFilePath) {
        lastClickSongIndex = runtime.songsArea.songInfoArr.findIndex(
          (item) => item.filePath === lastClickSongFilePath
        )
      }

      const clickSongIndex = runtime.songsArea.songInfoArr.findIndex(
        (item) => item.filePath === song.filePath
      )
      const sliceArr = runtime.songsArea.songInfoArr.slice(
        Math.min(lastClickSongIndex, clickSongIndex),
        Math.max(lastClickSongIndex, clickSongIndex) + 1
      )
      for (const item of sliceArr) {
        if (runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) === -1) {
          runtime.songsArea.selectedSongFilePath.push(item.filePath)
        }
      }
    } else {
      runtime.songsArea.selectedSongFilePath = [song.filePath]
    }
  }

  async function handleDeleteKey() {
    const selectedPaths = JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
    if (!selectedPaths.length) return false

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
      if (isInRecycleBin) {
        window.electron.ipcRenderer.invoke('permanentlyDelSongs', selectedPaths)
      } else {
        window.electron.ipcRenderer.send('delSongs', selectedPaths, getCurrentTimeDirName())
      }

      runtime.songsArea.selectedSongFilePath.length = 0
      scheduleSweepCovers()
      // 兜底：通知库区刷新当前歌单（包含回收站内删除与普通歌单删除）
      try {
        if (runtime.songsArea.songListUUID) {
          emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
        }
      } catch {}
    }
    return false
  }

  function getAnchorIndex(): number {
    const list = runtime.songsArea.songInfoArr
    if (!list || list.length === 0) return -1

    let anchorPath: string | null = null
    if (runtime.songsArea.selectedSongFilePath.length > 0) {
      anchorPath =
        runtime.songsArea.selectedSongFilePath[runtime.songsArea.selectedSongFilePath.length - 1]
    } else if (
      runtime.playingData.playingSong &&
      list.some((s) => s.filePath === runtime.playingData.playingSong!.filePath)
    ) {
      anchorPath = runtime.playingData.playingSong!.filePath
    } else {
      anchorPath = list[0].filePath
    }

    return list.findIndex((s) => s.filePath === anchorPath)
  }

  function addRangeSelection(startIndex: number, endIndex: number) {
    const list = runtime.songsArea.songInfoArr
    if (!list || list.length === 0) return
    const from = Math.max(0, Math.min(startIndex, endIndex))
    const to = Math.min(list.length - 1, Math.max(startIndex, endIndex))
    for (let i = from; i <= to; i++) {
      const p = list[i].filePath
      if (!runtime.songsArea.selectedSongFilePath.includes(p)) {
        runtime.songsArea.selectedSongFilePath.push(p)
      }
    }
  }

  function handleShiftHome() {
    const anchor = getAnchorIndex()
    if (anchor < 0) return false
    addRangeSelection(0, anchor)
    return false
  }

  function handleShiftEnd() {
    const anchor = getAnchorIndex()
    if (anchor < 0) return false
    addRangeSelection(anchor, runtime.songsArea.songInfoArr.length - 1)
    return false
  }

  function handleShiftPageUp() {
    const anchor = getAnchorIndex()
    if (anchor < 0) return false
    const ROW_HEIGHT = 30
    const page = Math.max(1, Math.floor((externalViewportHeight.value || 0) / ROW_HEIGHT) - 1)
    const target = Math.max(0, anchor - page)
    addRangeSelection(target, anchor)
    return false
  }

  function handleShiftPageDown() {
    const anchor = getAnchorIndex()
    if (anchor < 0) return false
    const ROW_HEIGHT = 30
    const page = Math.max(1, Math.floor((externalViewportHeight.value || 0) / ROW_HEIGHT) - 1)
    const target = Math.min(runtime.songsArea.songInfoArr.length - 1, anchor + page)
    addRangeSelection(anchor, target)
    return false
  }

  onMounted(() => {
    hotkeys('ctrl+a, command+a', 'windowGlobal', () => {
      runtime.songsArea.selectedSongFilePath.length = 0
      for (const item of runtime.songsArea.songInfoArr) {
        runtime.songsArea.selectedSongFilePath.push(item.filePath)
      }
      return false
    })
    hotkeys('delete', 'windowGlobal', () => {
      handleDeleteKey()
      return false
    })
    hotkeys('shift+home', 'windowGlobal', () => {
      handleShiftHome()
      return false
    })
    hotkeys('shift+end', 'windowGlobal', () => {
      handleShiftEnd()
      return false
    })
    hotkeys('shift+pageup', 'windowGlobal', () => {
      handleShiftPageUp()
      return false
    })
    hotkeys('shift+pagedown', 'windowGlobal', () => {
      handleShiftPageDown()
      return false
    })
  })

  onUnmounted(() => {
    hotkeys.unbind('shift+home', 'windowGlobal')
    hotkeys.unbind('shift+end', 'windowGlobal')
    hotkeys.unbind('shift+pageup', 'windowGlobal')
    hotkeys.unbind('shift+pagedown', 'windowGlobal')
  })

  return {
    songClick
  }
}
