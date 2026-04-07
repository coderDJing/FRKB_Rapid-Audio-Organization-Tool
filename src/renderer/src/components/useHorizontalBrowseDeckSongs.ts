import { ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { useRuntimeStore } from '@renderer/stores/runtime'

export const useHorizontalBrowseDeckSongs = () => {
  const runtime = useRuntimeStore()
  const topDeckSong = ref<ISongInfo | null>(null)
  const bottomDeckSong = ref<ISongInfo | null>(null)

  const setDeckSong = (deck: HorizontalBrowseDeckKey, song: ISongInfo | null) => {
    if (deck === 'top') {
      topDeckSong.value = song
      runtime.horizontalBrowseDecks.topSong = song ? { ...song } : null
      return
    }
    bottomDeckSong.value = song
    runtime.horizontalBrowseDecks.bottomSong = song ? { ...song } : null
  }

  const resolveDeckSong = (deck: HorizontalBrowseDeckKey) =>
    deck === 'top' ? topDeckSong.value : bottomDeckSong.value

  return {
    topDeckSong,
    bottomDeckSong,
    setDeckSong,
    resolveDeckSong
  }
}
