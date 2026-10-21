import { computed } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'

// 列表高亮和兼容调性筛选共用同一个参考轨。
export function useHarmonicReferenceKey(runtime: ReturnType<typeof useRuntimeStore>) {
  return computed(() => {
    if (runtime.mainWindowBrowseMode === 'browser') return ''
    const deck =
      runtime.mainWindowBrowseMode === 'edit' ? 'top' : runtime.horizontalBrowseDecks.leaderDeck
    if (deck === 'top') return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
    if (deck === 'bottom') return String(runtime.horizontalBrowseDecks.bottomSong?.key || '').trim()
    return ''
  })
}
