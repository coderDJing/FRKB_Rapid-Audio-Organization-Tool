import { onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

type ClipboardOperation = 'copy' | 'cut'

type DeleteSummary = {
  total?: number
  success?: number
  failed?: number
  removedPaths?: string[]
}

type OptimisticRestoreItem = {
  song: ISongInfo
  index: number
}

type WaveformPreviewStatePayload = {
  active?: boolean
  song?: ISongInfo | null
}

let windowHotkeyBinderCount = 0
let windowPreviewHotkeysLocked = false

interface UseKeyboardSelectionParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  externalViewportHeight: { value: number }
  scheduleSweepCovers: () => void
}

export function useKeyboardSelection(params: UseKeyboardSelectionParams) {
  const { runtime, songsAreaState, externalViewportHeight, scheduleSweepCovers } = params
  const CUT_POLL_INTERVAL_MS = 1500
  const CUT_POLL_TIMEOUT_MS = 2 * 60 * 1000
  let cutPollTimer: ReturnType<typeof setInterval> | null = null
  let cutPollStartAt = 0
  let cutPollInFlight = false
  let pendingCutPaths = new Set<string>()
  let pendingCutListUUID = ''
  const normalizePath = (p: string | undefined | null) =>
    (p || '').replace(/\//g, '\\').toLowerCase()

  const isMixtapeViewForState = (state: ISongsAreaPaneRuntimeState) =>
    libraryUtils.getLibraryTreeByUUID(state.songListUUID)?.type === 'mixtapeList'
  const isMixtapeView = () => isMixtapeViewForState(songsAreaState)
  const getRowKeyForState = (state: ISongsAreaPaneRuntimeState, song: ISongInfo) =>
    isMixtapeViewForState(state) && song.mixtapeItemId ? song.mixtapeItemId : song.filePath
  const getRowKey = (song: ISongInfo) => getRowKeyForState(songsAreaState, song)
  const getSelectedKeys = () => songsAreaState.selectedSongFilePath
  const setSelectedKeys = (next: string[]) => {
    songsAreaState.selectedSongFilePath = next
  }
  const resolveSelectedFilePathsForState = (state: ISongsAreaPaneRuntimeState, keys?: string[]) => {
    const selectedKeys = keys ?? state.selectedSongFilePath
    if (!isMixtapeViewForState(state)) return selectedKeys
    const map = new Map<string, string>()
    for (const item of state.songInfoArr) {
      if (item.mixtapeItemId) {
        map.set(item.mixtapeItemId, item.filePath)
      }
    }
    return selectedKeys
      .map((key) => map.get(key) || key)
      .filter((p) => typeof p === 'string' && p.length > 0)
  }
  const resolveSelectedFilePaths = (keys?: string[]) =>
    resolveSelectedFilePathsForState(songsAreaState, keys)

  const clearPlayingStateIfTouched = (normalizedPathSet: Set<string>) => {
    const touchesCurrentPlaying =
      runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID &&
      normalizedPathSet.has(normalizePath(runtime.playingData.playingSong?.filePath))
    if (!touchesCurrentPlaying) return false
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
    runtime.playingData.playingSong = null
    return true
  }

  const songClick = (event: MouseEvent, song: ISongInfo) => {
    if (runtime.songDragSuppressClickUntilMs > Date.now()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    runtime.activeMenuUUID = ''
    const rowKey = getRowKey(song)
    if (event.ctrlKey) {
      const index = getSelectedKeys().indexOf(rowKey)
      if (index !== -1) {
        songsAreaState.selectedSongFilePath.splice(index, 1)
      } else {
        songsAreaState.selectedSongFilePath.push(rowKey)
      }
    } else if (event.shiftKey) {
      let lastClickSongFilePath: string | null = null
      if (getSelectedKeys().length) {
        lastClickSongFilePath = getSelectedKeys()[getSelectedKeys().length - 1]
      }
      let lastClickSongIndex = 0
      if (lastClickSongFilePath) {
        lastClickSongIndex = songsAreaState.songInfoArr.findIndex(
          (item) => getRowKey(item) === lastClickSongFilePath
        )
      }

      const clickSongIndex = songsAreaState.songInfoArr.findIndex(
        (item) => getRowKey(item) === rowKey
      )
      const sliceArr = songsAreaState.songInfoArr.slice(
        Math.min(lastClickSongIndex, clickSongIndex),
        Math.max(lastClickSongIndex, clickSongIndex) + 1
      )
      for (const item of sliceArr) {
        const key = getRowKey(item)
        if (getSelectedKeys().indexOf(key) === -1) {
          songsAreaState.selectedSongFilePath.push(key)
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
        startCutPolling(existingPaths, songsAreaState.songListUUID)
      }
    }
  }

  const handleWaveformPreviewState = (payload?: WaveformPreviewStatePayload) => {
    windowPreviewHotkeysLocked = Boolean(payload?.active && payload?.song?.filePath)
  }

  async function handleDeleteKey() {
    const activeSongsAreaState = runtime.songsArea
    const selectedKeys = JSON.parse(JSON.stringify(activeSongsAreaState.selectedSongFilePath))
    if (!selectedKeys.length) return false

    const isInRecycleBin = activeSongsAreaState.songListUUID === RECYCLE_BIN_UUID
    const isExternalView = activeSongsAreaState.songListUUID === EXTERNAL_PLAYLIST_UUID
    if (isMixtapeViewForState(activeSongsAreaState)) {
      await window.electron.ipcRenderer.invoke('mixtape:remove', {
        playlistId: activeSongsAreaState.songListUUID,
        itemIds: [...selectedKeys]
      })
      activeSongsAreaState.selectedSongFilePath.length = 0
      emitter.emit('playlistContentChanged', { uuids: [activeSongsAreaState.songListUUID] })
      emitter.emit('songsRemoved', {
        listUUID: activeSongsAreaState.songListUUID,
        itemIds: selectedKeys
      })
      return false
    }

    const buildDelSongsPayload = (paths: string[]) => {
      if (isExternalView) {
        return { filePaths: paths, sourceType: 'external' }
      }
      const songListPath = libraryUtils.findDirPathByUuid(activeSongsAreaState.songListUUID)
      if (songListPath) {
        return { filePaths: paths, songListPath }
      }
      return paths
    }
    const requestDeleteSongs = async (paths: string[]) => {
      const summary = await window.electron.ipcRenderer.invoke(
        'delSongsAwaitable',
        buildDelSongsPayload(paths)
      )
      return {
        total: Number(summary?.total || 0),
        success: Number(summary?.success || 0),
        failed: Number(summary?.failed || 0),
        removedPaths: Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
      } as DeleteSummary
    }

    const showDeleteSummaryIfNeeded = async (
      summary: {
        total?: number
        success?: number
        failed?: number
      },
      options?: {
        restoredFailed?: boolean
      }
    ) => {
      const total = Number(summary?.total || 0)
      const success = Number(summary?.success || 0)
      const failed = Number(summary?.failed || 0)
      if (total <= 1 && failed === 0) return
      const content: string[] = []
      content.push(t('recycleBin.deleteSummarySuccess', { count: success }))
      if (failed > 0) {
        content.push(t('recycleBin.deleteSummaryFailed', { count: failed }))
        if (options?.restoredFailed) {
          content.push(t('recycleBin.deleteSummaryRestoredFailed', { count: failed }))
        }
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
      const selectedSnapshot = [...activeSongsAreaState.songInfoArr]
      const resolvedSelectedPaths = resolveSelectedFilePathsForState(
        activeSongsAreaState,
        selectedKeys
      )
      let removedPathsForEvent = [...resolvedSelectedPaths]
      const selectedPathSet = new Set(resolvedSelectedPaths.map((item) => normalizePath(item)))
      const optimisticRestoreItems: OptimisticRestoreItem[] = selectedSnapshot
        .map((item, index) => ({ song: { ...item }, index }))
        .filter((item) => selectedPathSet.has(normalizePath(item.song.filePath)))

      clearPlayingStateIfTouched(selectedPathSet)
      emitter.emit('songsArea/optimistic-remove', {
        listUUID: activeSongsAreaState.songListUUID,
        paths: resolvedSelectedPaths
      })

      try {
        let deleteSummary: DeleteSummary
        if (isInRecycleBin) {
          const summary = await window.electron.ipcRenderer.invoke(
            'permanentlyDelSongs',
            resolvedSelectedPaths
          )
          deleteSummary = {
            total: Number(summary?.total || 0),
            success: Number(summary?.success || 0),
            failed: Number(summary?.failed || 0),
            removedPaths: Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
          }
        } else {
          deleteSummary = await requestDeleteSongs(resolvedSelectedPaths)
        }
        removedPathsForEvent = deleteSummary.removedPaths || []
        const removedNormalizedSet = new Set(
          removedPathsForEvent.map((item) => normalizePath(item))
        )
        const failedRestoreItems =
          Number(deleteSummary.failed || 0) > 0
            ? optimisticRestoreItems.filter(
                (item) => !removedNormalizedSet.has(normalizePath(item.song.filePath))
              )
            : []
        if (failedRestoreItems.length > 0) {
          emitter.emit('songsArea/optimistic-restore', {
            listUUID: activeSongsAreaState.songListUUID,
            items: failedRestoreItems
          })
        }
        if (isInRecycleBin || Number(deleteSummary.failed || 0) > 0) {
          await showDeleteSummaryIfNeeded(deleteSummary, {
            restoredFailed: failedRestoreItems.length > 0
          })
        }
      } catch {
        if (optimisticRestoreItems.length > 0) {
          emitter.emit('songsArea/optimistic-restore', {
            listUUID: activeSongsAreaState.songListUUID,
            items: optimisticRestoreItems
          })
        }
        await showDeleteSummaryIfNeeded(
          {
            total: resolvedSelectedPaths.length,
            success: 0,
            failed: resolvedSelectedPaths.length
          },
          { restoredFailed: optimisticRestoreItems.length > 0 }
        )
        return false
      }

      activeSongsAreaState.selectedSongFilePath.length = 0
      if (removedPathsForEvent.length > 0) {
        emitter.emit('songsRemoved', {
          listUUID: activeSongsAreaState.songListUUID,
          paths: removedPathsForEvent
        })
      }
      // 兜底：通知库区刷新当前歌单（包含回收站内删除与普通歌单删除）
      try {
        if (activeSongsAreaState.songListUUID) {
          emitter.emit('playlistContentChanged', { uuids: [activeSongsAreaState.songListUUID] })
        }
      } catch {}
    }
    return false
  }

  function getAnchorIndex(): number {
    const activeSongsAreaState = runtime.songsArea
    const list = activeSongsAreaState.songInfoArr
    if (!list || list.length === 0) return -1

    let anchorKey: string | null = null
    if (activeSongsAreaState.selectedSongFilePath.length > 0) {
      anchorKey =
        activeSongsAreaState.selectedSongFilePath[
          activeSongsAreaState.selectedSongFilePath.length - 1
        ]
    } else if (
      runtime.playingData.playingSong &&
      list.some(
        (s) =>
          getRowKeyForState(activeSongsAreaState, s) ===
          getRowKeyForState(activeSongsAreaState, runtime.playingData.playingSong!)
      )
    ) {
      anchorKey = getRowKeyForState(activeSongsAreaState, runtime.playingData.playingSong!)
    } else {
      anchorKey = getRowKeyForState(activeSongsAreaState, list[0])
    }

    return list.findIndex((s) => getRowKeyForState(activeSongsAreaState, s) === anchorKey)
  }

  function addRangeSelection(startIndex: number, endIndex: number) {
    const activeSongsAreaState = runtime.songsArea
    const list = activeSongsAreaState.songInfoArr
    if (!list || list.length === 0) return
    const from = Math.max(0, Math.min(startIndex, endIndex))
    const to = Math.min(list.length - 1, Math.max(startIndex, endIndex))
    for (let i = from; i <= to; i++) {
      const key = getRowKeyForState(activeSongsAreaState, list[i])
      if (!activeSongsAreaState.selectedSongFilePath.includes(key)) {
        activeSongsAreaState.selectedSongFilePath.push(key)
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
    const shouldBindWindowHotkeys = windowHotkeyBinderCount === 0
    windowHotkeyBinderCount += 1
    emitter.on('waveform-preview:state', handleWaveformPreviewState)
    if (!shouldBindWindowHotkeys) return
    hotkeys('ctrl+a, command+a', 'windowGlobal', () => {
      if (windowPreviewHotkeysLocked) return false
      runtime.songsArea.selectedSongFilePath.length = 0
      for (const item of runtime.songsArea.songInfoArr) {
        runtime.songsArea.selectedSongFilePath.push(getRowKeyForState(runtime.songsArea, item))
      }
      return false
    })
    hotkeys('delete', 'windowGlobal', () => {
      if (windowPreviewHotkeysLocked) return false
      handleDeleteKey()
      return false
    })
    hotkeys('ctrl+c, command+c', 'windowGlobal', (event) => {
      if (windowPreviewHotkeysLocked) return false
      if (shouldSkipClipboardHotkey(event)) return true
      const selectedKeys = [...runtime.songsArea.selectedSongFilePath]
      if (selectedKeys.length === 0) return true
      const selectedPaths = resolveSelectedFilePathsForState(runtime.songsArea, selectedKeys)
      if (selectedPaths.length === 0) return true
      void writeFilesToClipboard('copy', selectedPaths)
      return false
    })
    hotkeys('ctrl+x, command+x', 'windowGlobal', (event) => {
      if (windowPreviewHotkeysLocked) return false
      if (shouldSkipClipboardHotkey(event)) return true
      const selectedKeys = [...runtime.songsArea.selectedSongFilePath]
      if (selectedKeys.length === 0) return true
      const selectedPaths = resolveSelectedFilePathsForState(runtime.songsArea, selectedKeys)
      if (selectedPaths.length === 0) return true
      void writeFilesToClipboard('cut', selectedPaths)
      return false
    })
    hotkeys('shift+home', 'windowGlobal', () => {
      if (windowPreviewHotkeysLocked) return false
      handleShiftHome()
      return false
    })
    hotkeys('shift+end', 'windowGlobal', () => {
      if (windowPreviewHotkeysLocked) return false
      handleShiftEnd()
      return false
    })
    hotkeys('shift+pageup', 'windowGlobal', () => {
      if (windowPreviewHotkeysLocked) return false
      handleShiftPageUp()
      return false
    })
    hotkeys('shift+pagedown', 'windowGlobal', () => {
      if (windowPreviewHotkeysLocked) return false
      handleShiftPageDown()
      return false
    })
  })

  onUnmounted(() => {
    emitter.off('waveform-preview:state', handleWaveformPreviewState)
    windowHotkeyBinderCount = Math.max(0, windowHotkeyBinderCount - 1)
    if (windowHotkeyBinderCount > 0) return
    windowPreviewHotkeysLocked = false
    hotkeys.unbind('ctrl+a, command+a', 'windowGlobal')
    hotkeys.unbind('delete', 'windowGlobal')
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
