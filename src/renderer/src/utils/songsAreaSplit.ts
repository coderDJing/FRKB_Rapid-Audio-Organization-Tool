import type {
  ISongsAreaPaneRuntimeState,
  SongsAreaPaneKey,
  SplitSongsAreaPaneKey
} from '@renderer/stores/runtime'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

const cloneSongsAreaPaneState = (
  state: ISongsAreaPaneRuntimeState
): ISongsAreaPaneRuntimeState => ({
  songListUUID: String(state.songListUUID || ''),
  songInfoArr: Array.isArray(state.songInfoArr) ? [...state.songInfoArr] : [],
  totalSongCount: Number(state.totalSongCount || 0),
  selectedSongFilePath: Array.isArray(state.selectedSongFilePath)
    ? [...state.selectedSongFilePath]
    : [],
  scrollTop: Number.isFinite(state.scrollTop) ? state.scrollTop : 0,
  scrollLeft: Number.isFinite(state.scrollLeft) ? state.scrollLeft : 0,
  columnCacheByMode: Object.fromEntries(
    Object.entries(state.columnCacheByMode || {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map((item) => ({ ...item })) : []
    ])
  ) as ISongsAreaPaneRuntimeState['columnCacheByMode']
})

const buildPaneStateWithSongList = (
  source: ISongsAreaPaneRuntimeState,
  songListUUID: string
): ISongsAreaPaneRuntimeState => ({
  ...cloneSongsAreaPaneState(source),
  songListUUID,
  songInfoArr: [],
  totalSongCount: 0,
  selectedSongFilePath: [],
  scrollTop: 0,
  scrollLeft: 0
})

const isPlainSongListUUID = (uuid: string) =>
  libraryUtils.getLibraryTreeByUUID(uuid)?.type === 'songList'

const syncPlayingSongListDataFromVisiblePane = (runtime: RuntimeStore) => {
  const playingSongListUUID = String(runtime.playingData.playingSongListUUID || '')
  if (!playingSongListUUID) return

  const paneOrder = runtime.songsAreaPanels.splitEnabled
    ? (['left', 'right', 'single'] as const)
    : (['single', 'left', 'right'] as const)
  const matchedPane = paneOrder.find(
    (pane) => runtime.songsAreaPanels.panes[pane].songListUUID === playingSongListUUID
  )
  if (!matchedPane) return

  runtime.playingData.playingSongListData = runtime.songsAreaPanels.panes[matchedPane].songInfoArr
}

export const getSongsAreaOppositePane = (pane: SplitSongsAreaPaneKey): SplitSongsAreaPaneKey =>
  pane === 'left' ? 'right' : 'left'

export const resolveOpenedSplitPaneBySongListUUID = (
  runtime: RuntimeStore,
  songListUUID: string
): SplitSongsAreaPaneKey | null => {
  for (const pane of ['left', 'right'] as const) {
    if (runtime.songsAreaPanels.panes[pane].songListUUID === songListUUID) {
      return pane
    }
  }
  return null
}

export const activateSongsAreaPane = (runtime: RuntimeStore, pane: SongsAreaPaneKey) => {
  runtime.setSongsAreaActivePane(pane)
}

export const clearSongsAreaPaneBySongListUUID = (runtime: RuntimeStore, songListUUID: string) => {
  for (const pane of ['single', 'left', 'right'] as const) {
    if (runtime.songsAreaPanels.panes[pane].songListUUID === songListUUID) {
      runtime.clearSongsAreaPaneState(pane)
    }
  }
}

export const replaceSongsAreaPaneSongList = (
  runtime: RuntimeStore,
  pane: SongsAreaPaneKey,
  songListUUID: string
) => {
  const paneState = runtime.songsAreaPanels.panes[pane]
  const nextState =
    paneState.songListUUID === songListUUID
      ? cloneSongsAreaPaneState(paneState)
      : buildPaneStateWithSongList(paneState, songListUUID)
  runtime.assignSongsAreaPaneState(pane, nextState)
}

export const showSongListInPane = (
  runtime: RuntimeStore,
  pane: SplitSongsAreaPaneKey,
  songListUUID: string
) => {
  const panes = runtime.songsAreaPanels.panes
  const otherPane = getSongsAreaOppositePane(pane)

  if (runtime.songsAreaPanels.splitEnabled) {
    if (panes[pane].songListUUID === songListUUID) {
      runtime.setSongsAreaActivePane(pane)
      syncPlayingSongListDataFromVisiblePane(runtime)
      return
    }
    if (panes[otherPane].songListUUID === songListUUID) {
      const targetSnapshot = cloneSongsAreaPaneState(panes[pane])
      runtime.assignSongsAreaPaneState(pane, panes[otherPane])
      runtime.assignSongsAreaPaneState(otherPane, targetSnapshot)
      runtime.setSongsAreaActivePane(pane)
      syncPlayingSongListDataFromVisiblePane(runtime)
      return
    }
    replaceSongsAreaPaneSongList(runtime, pane, songListUUID)
    runtime.setSongsAreaActivePane(pane)
    syncPlayingSongListDataFromVisiblePane(runtime)
    return
  }

  const singleSnapshot = cloneSongsAreaPaneState(panes.single)
  const currentIsPlainSongList = isPlainSongListUUID(singleSnapshot.songListUUID)
  const preserveSnapshot =
    currentIsPlainSongList && singleSnapshot.songListUUID !== songListUUID ? singleSnapshot : null
  const paneSnapshot =
    currentIsPlainSongList && singleSnapshot.songListUUID === songListUUID
      ? singleSnapshot
      : buildPaneStateWithSongList(singleSnapshot, songListUUID)

  runtime.assignSongsAreaPaneState(pane, paneSnapshot)
  if (preserveSnapshot) {
    runtime.assignSongsAreaPaneState(otherPane, preserveSnapshot)
  } else {
    runtime.clearSongsAreaPaneState(otherPane)
  }
  runtime.songsAreaPanels.splitEnabled = true
  runtime.setSongsAreaActivePane(pane)
  syncPlayingSongListDataFromVisiblePane(runtime)
}

export const exitSongsAreaSplit = (runtime: RuntimeStore, paneToKeep: SplitSongsAreaPaneKey) => {
  runtime.assignSongsAreaPaneState('single', runtime.songsAreaPanels.panes[paneToKeep])
  runtime.songsAreaPanels.splitEnabled = false
  runtime.setSongsAreaActivePane('single')
  syncPlayingSongListDataFromVisiblePane(runtime)
}

export const closeSongsAreaSplitPane = (
  runtime: RuntimeStore,
  paneToClose: SplitSongsAreaPaneKey
) => {
  exitSongsAreaSplit(runtime, getSongsAreaOppositePane(paneToClose))
}

export const resolveSongsAreaPaneForLibraryClick = (runtime: RuntimeStore): SongsAreaPaneKey => {
  if (!runtime.songsAreaPanels.splitEnabled) return 'single'
  const activePane = runtime.songsAreaPanels.activePane
  if (activePane === 'left' || activePane === 'right') return activePane
  return 'left'
}
