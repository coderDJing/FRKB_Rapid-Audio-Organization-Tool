import { computed, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'
import type { FocusSongPayload } from './useGlobalSearchFocus'

type DeckKey = 'top' | 'bottom'
export type SongsAreaDeckLocateTarget = { deck: DeckKey; filePath: string; rowKey: string }

export function useSongsAreaDeckLocate(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: Ref<ISongInfo[]>
  viewState: Ref<string>
  getRowKey: (song: ISongInfo) => string
  focusSong: (payload: FocusSongPayload) => void
}) {
  const { runtime, songsAreaState, originalSongInfoArr, viewState, getRowKey, focusSong } = params
  const normalizePath = (value: string) =>
    normalizeFilePathForComparison(
      value,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )

  const deckLocateTargets = computed<SongsAreaDeckLocateTarget[]>(() => {
    if (runtime.mainWindowBrowseMode !== 'horizontal' || viewState.value !== 'list') return []
    const targets: SongsAreaDeckLocateTarget[] = []
    for (const deck of ['top', 'bottom'] as const) {
      const song = runtime.horizontalBrowseDecks[deck === 'top' ? 'topSong' : 'bottomSong']
      if (!song?.filePath) continue
      const filePath = normalizePath(song.filePath)
      const matches = originalSongInfoArr.value.filter(
        (item) => normalizePath(item.filePath) === filePath
      )
      // SET / mixtape 同文件可有多行，优先定位载入轨道时的那一条。
      const target = matches.find((item) => getRowKey(item) === getRowKey(song)) || matches[0]
      if (target) targets.push({ deck, filePath: target.filePath, rowKey: getRowKey(target) })
    }
    return targets
  })

  const locateDeckSong = (deck: DeckKey) => {
    const target = deckLocateTargets.value.find((item) => item.deck === deck)
    if (!target) return
    focusSong({
      songListUUID: songsAreaState.songListUUID,
      filePath: target.filePath,
      rowKey: target.rowKey,
      flash: true,
      waitForListStabilize: false
    })
  }

  return { deckLocateTargets, locateDeckSong }
}
