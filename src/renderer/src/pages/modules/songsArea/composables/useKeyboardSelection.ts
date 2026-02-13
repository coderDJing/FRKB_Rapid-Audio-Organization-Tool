import { onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

type ClipboardOperation = 'copy' | 'cut'

interface UseKeyboardSelectionParams {
  runtime: ReturnType<typeof useRuntimeStore>
  externalViewportHeight: { value: number }
  scheduleSweepCovers: () => void
}

export function useKeyboardSelection(params: UseKeyboardSelectionParams) {
  const { runtime, externalViewportHeight, scheduleSweepCovers } = params
  const CUT_POLL_INTERVAL_MS = 1500
  const CUT_POLL_TIMEOUT_MS = 2 * 60 * 1000
  let cutPollTimer: ReturnType<typeof setInterval> | null = null
  let cutPollStartAt = 0
  let cutPollInFlight = false
  let pendingCutPaths = new Set<string>()
  let pendingCutListUUID = ''

  const isMixtapeView = () =>
    libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)?.type === 'mixtapeList'
  const getRowKey = (song: ISongInfo) =>
    isMixtapeView() && song.mixtapeItemId ? song.mixtapeItemId : song.filePath
  const getSelectedKeys = () => runtime.songsArea.selectedSongFilePath
  const setSelectedKeys = (next: string[]) => {
    runtime.songsArea.selectedSongFilePath = next
  }
  const resolveSelectedFilePaths = (keys?: string[]) => {
    const selectedKeys = keys ?? getSelectedKeys()
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

  const songClick = (event: MouseEvent, song: ISongInfo) => {
    runtime.activeMenuUUID = ''
    const rowKey = getRowKey(song)
    if (event.ctrlKey) {
      const index = getSelectedKeys().indexOf(rowKey)
      if (index !== -1) {
        runtime.songsArea.selectedSongFilePath.splice(index, 1)
      } else {
        runtime.songsArea.selectedSongFilePath.push(rowKey)
      }
    } else if (event.shiftKey) {
      let lastClickSongFilePath: string | null = null
      if (getSelectedKeys().length) {
        lastClickSongFilePath = getSelectedKeys()[getSelectedKeys().length - 1]
      }
      let lastClickSongIndex = 0
      if (lastClickSongFilePath) {
        lastClickSongIndex = runtime.songsArea.songInfoArr.findIndex(
          (item) => getRowKey(item) === lastClickSongFilePath
        )
      }

      const clickSongIndex = runtime.songsArea.songInfoArr.findIndex(
        (item) => getRowKey(item) === rowKey
      )
      const sliceArr = runtime.songsArea.songInfoArr.slice(
        Math.min(lastClickSongIndex, clickSongIndex),
        Math.max(lastClickSongIndex, clickSongIndex) + 1
      )
      for (const item of sliceArr) {
        const key = getRowKey(item)
        if (getSelectedKeys().indexOf(key) === -1) {
          runtime.songsArea.selectedSongFilePath.push(key)
        }
      }
    } else {
      setSelectedKeys([rowKey])
    }
  }

  const isEditableElement = (target: Element | null) => {
    if (!target) return false
    const tagName = target.tagName
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true
    return (target as HTMLElement).isContentEditable
  }

  const hasTextSelection = () => {
    const selection = window.getSelection()
    if (!selection) return false
    return selection.toString().length > 0
  }

  const shouldSkipClipboardHotkey = (event?: KeyboardEvent) => {
    if (isEditableElement(document.activeElement)) return true
    if (event?.target && isEditableElement(event.target as Element)) return true
    if (hasTextSelection()) return true
    return false
  }

  const stopCutPolling = () => {
    if (cutPollTimer) {
      clearInterval(cutPollTimer)
      cutPollTimer = null
    }
    cutPollStartAt = 0
    cutPollInFlight = false
    pendingCutPaths.clear()
    pendingCutListUUID = ''
  }

  const pollCutPaths = async () => {
    if (cutPollInFlight || pendingCutPaths.size === 0) return
    if (cutPollStartAt && Date.now() - cutPollStartAt > CUT_POLL_TIMEOUT_MS) {
      stopCutPolling()
      return
    }
    cutPollInFlight = true
    try {
      const paths = Array.from(pendingCutPaths)
      const result = await window.electron.ipcRenderer.invoke('paths:exists', { paths })
      const existingPaths = new Set<string>(
        Array.isArray(result?.existingPaths) ? result.existingPaths : []
      )
      const missingPaths = paths.filter((p) => !existingPaths.has(p))
      if (missingPaths.length > 0) {
        missingPaths.forEach((p) => pendingCutPaths.delete(p))
        emitter.emit('songsRemoved', {
          listUUID: pendingCutListUUID,
          paths: missingPaths
        })
        if (pendingCutListUUID) {
          emitter.emit('playlistContentChanged', { uuids: [pendingCutListUUID] })
        }
      }
      if (pendingCutPaths.size === 0) {
        stopCutPolling()
      }
    } catch {
      // 轮询异常时不终止，下一轮继续确认
    } finally {
      cutPollInFlight = false
    }
  }

  const startCutPolling = (paths: string[], listUUID: string) => {
    stopCutPolling()
    if (paths.length === 0) return
    pendingCutPaths = new Set(paths)
    pendingCutListUUID = listUUID
    cutPollStartAt = Date.now()
    cutPollTimer = setInterval(() => {
      void pollCutPaths()
    }, CUT_POLL_INTERVAL_MS)
    void pollCutPaths()
  }

  const writeFilesToClipboard = async (operation: ClipboardOperation, filePaths: string[]) => {
    const result = await window.electron.ipcRenderer.invoke('clipboard:write-files', {
      filePaths,
      operation
    })
    const existingPaths = Array.isArray(result?.existingPaths) ? result.existingPaths : []
    if (result?.success && existingPaths.length > 0) {
      emitter.emit('songsArea/clipboardHint', { action: operation })
      if (operation === 'cut') {
        startCutPolling(existingPaths, runtime.songsArea.songListUUID)
      }
    }
  }

  async function handleDeleteKey() {
    const selectedKeys = JSON.parse(JSON.stringify(getSelectedKeys()))
    if (!selectedKeys.length) return false

    const isInRecycleBin = runtime.songsArea.songListUUID === RECYCLE_BIN_UUID
    const isExternalView = runtime.songsArea.songListUUID === EXTERNAL_PLAYLIST_UUID
    if (isMixtapeView()) {
      await window.electron.ipcRenderer.invoke('mixtape:remove', {
        playlistId: runtime.songsArea.songListUUID,
        itemIds: [...selectedKeys]
      })
      runtime.songsArea.selectedSongFilePath.length = 0
      emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
      emitter.emit('songsRemoved', {
        listUUID: runtime.songsArea.songListUUID,
        itemIds: selectedKeys
      })
      return false
    }

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

    let shouldDelete = true
    if (isInRecycleBin) {
      const res = await confirm({
        title: t('common.delete'),
        content: [t('tracks.confirmDeleteSelected'), t('tracks.deleteHint')]
      })
      shouldDelete = res === 'confirm'
    }

    if (shouldDelete) {
      const resolvedSelectedPaths = resolveSelectedFilePaths(selectedKeys)
      let removedPathsForEvent = [...resolvedSelectedPaths]
      if (isInRecycleBin) {
        const summary = await window.electron.ipcRenderer.invoke(
          'permanentlyDelSongs',
          resolvedSelectedPaths
        )
        const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
        removedPathsForEvent = removedPaths
        await showDeleteSummaryIfNeeded(summary)
      } else {
        window.electron.ipcRenderer.send('delSongs', buildDelSongsPayload(resolvedSelectedPaths))
      }

      runtime.songsArea.selectedSongFilePath.length = 0
      scheduleSweepCovers()
      if (removedPathsForEvent.length > 0) {
        emitter.emit('songsRemoved', {
          listUUID: runtime.songsArea.songListUUID,
          paths: removedPathsForEvent
        })
      }
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

    let anchorKey: string | null = null
    if (getSelectedKeys().length > 0) {
      anchorKey = getSelectedKeys()[getSelectedKeys().length - 1]
    } else if (
      runtime.playingData.playingSong &&
      list.some((s) => getRowKey(s) === getRowKey(runtime.playingData.playingSong!))
    ) {
      anchorKey = getRowKey(runtime.playingData.playingSong!)
    } else {
      anchorKey = getRowKey(list[0])
    }

    return list.findIndex((s) => getRowKey(s) === anchorKey)
  }

  function addRangeSelection(startIndex: number, endIndex: number) {
    const list = runtime.songsArea.songInfoArr
    if (!list || list.length === 0) return
    const from = Math.max(0, Math.min(startIndex, endIndex))
    const to = Math.min(list.length - 1, Math.max(startIndex, endIndex))
    for (let i = from; i <= to; i++) {
      const key = getRowKey(list[i])
      if (!getSelectedKeys().includes(key)) {
        runtime.songsArea.selectedSongFilePath.push(key)
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
        runtime.songsArea.selectedSongFilePath.push(getRowKey(item))
      }
      return false
    })
    hotkeys('delete', 'windowGlobal', () => {
      handleDeleteKey()
      return false
    })
    hotkeys('ctrl+c, command+c', 'windowGlobal', (event) => {
      if (shouldSkipClipboardHotkey(event)) return true
      const selectedKeys = [...getSelectedKeys()]
      if (selectedKeys.length === 0) return true
      const selectedPaths = resolveSelectedFilePaths(selectedKeys)
      if (selectedPaths.length === 0) return true
      void writeFilesToClipboard('copy', selectedPaths)
      return false
    })
    hotkeys('ctrl+x, command+x', 'windowGlobal', (event) => {
      if (shouldSkipClipboardHotkey(event)) return true
      const selectedKeys = [...getSelectedKeys()]
      if (selectedKeys.length === 0) return true
      const selectedPaths = resolveSelectedFilePaths(selectedKeys)
      if (selectedPaths.length === 0) return true
      void writeFilesToClipboard('cut', selectedPaths)
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
    hotkeys.unbind('ctrl+c, command+c', 'windowGlobal')
    hotkeys.unbind('ctrl+x, command+x', 'windowGlobal')
    hotkeys.unbind('shift+home', 'windowGlobal')
    hotkeys.unbind('shift+end', 'windowGlobal')
    hotkeys.unbind('shift+pageup', 'windowGlobal')
    hotkeys.unbind('shift+pagedown', 'windowGlobal')
    stopCutPolling()
  })

  return {
    songClick
  }
}
