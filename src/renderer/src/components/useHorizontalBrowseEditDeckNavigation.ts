import { computed, ref, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/components/horizontalBrowseInteractionTimeline'
import { useRuntimeStore } from '@renderer/stores/runtime'

type DeckKey = HorizontalBrowseDeckKey
export type HorizontalBrowseEditBeatStep = 4 | 8 | 16 | 32 | 128

type UseHorizontalBrowseEditDeckNavigationParams = {
  topDeckSong: Ref<ISongInfo | null>
  assignSongToDeck: (deck: DeckKey, song: ISongInfo) => Promise<unknown>
  handleDeckBeatJump: (deck: DeckKey, direction: -1 | 1, beatCount: number) => void
}

const resolveSongQueueKey = (song: ISongInfo | null | undefined) =>
  String(song?.mixtapeItemId || song?.filePath || '').trim()

const resolveSongFilePath = (song: ISongInfo | null | undefined) =>
  String(song?.filePath || '').trim()

const resolveCurrentSongIndex = (songs: ISongInfo[], currentSong: ISongInfo | null) => {
  const currentKey = resolveSongQueueKey(currentSong)
  if (currentKey) {
    const keyIndex = songs.findIndex((song) => resolveSongQueueKey(song) === currentKey)
    if (keyIndex >= 0) return keyIndex
  }

  const currentFilePath = resolveSongFilePath(currentSong)
  if (!currentFilePath) return -1
  return songs.findIndex((song) => resolveSongFilePath(song) === currentFilePath)
}

export const useHorizontalBrowseEditDeckNavigation = ({
  topDeckSong,
  assignSongToDeck,
  handleDeckBeatJump
}: UseHorizontalBrowseEditDeckNavigationParams) => {
  const runtime = useRuntimeStore()
  const editBeatStep = ref<HorizontalBrowseEditBeatStep>(4)

  const editModeQueue = computed(() =>
    runtime.playingData.playingSongListData.filter((song) => Boolean(resolveSongFilePath(song)))
  )
  const currentEditQueueIndex = computed(() =>
    resolveCurrentSongIndex(editModeQueue.value, topDeckSong.value)
  )
  const canPreviousEditSong = computed(() => currentEditQueueIndex.value > 0)
  const canNextEditSong = computed(
    () =>
      currentEditQueueIndex.value >= 0 &&
      currentEditQueueIndex.value < editModeQueue.value.length - 1
  )

  const loadEditAdjacentSong = (direction: -1 | 1) => {
    const currentIndex = currentEditQueueIndex.value
    if (currentIndex < 0) return
    const nextSong = editModeQueue.value[currentIndex + direction]
    const filePath = resolveSongFilePath(nextSong)
    if (!filePath) return
    beginHorizontalBrowseDeckInteraction('top', filePath)
    void assignSongToDeck('top', { ...nextSong })
  }

  const jumpEditDeckByBeats = (direction: -1 | 1) => {
    if (!topDeckSong.value) return
    handleDeckBeatJump('top', direction, editBeatStep.value)
  }

  return {
    editBeatStep,
    canPreviousEditSong,
    canNextEditSong,
    loadEditAdjacentSong,
    jumpEditDeckByBeats
  }
}
