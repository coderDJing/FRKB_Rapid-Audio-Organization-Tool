import { nextTick } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

interface UseAutoScrollParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaRef: { value: OverlayScrollbarsComponentRef }
}

export function useAutoScrollToCurrent(params: UseAutoScrollParams) {
  const { runtime, songsAreaRef } = params

  const ROW_HEIGHT = 30

  const scrollToIndex = (index: number) => {
    if (!Number.isFinite(index) || index < 0) return
    if (!songsAreaRef.value) return
    nextTick(() => {
      const scrollInstance = songsAreaRef.value?.osInstance()
      const viewportElement = scrollInstance?.elements().viewport as HTMLElement | undefined
      if (!viewportElement) return

      const targetTop = index * ROW_HEIGHT
      const centerTop = Math.max(0, targetTop - viewportElement.clientHeight / 2)
      try {
        viewportElement.scrollTo({ top: centerTop, behavior: 'smooth' })
      } catch {
        viewportElement.scrollTop = centerTop
      }
    })
  }

  const scrollToSong = (filePath?: string | null) => {
    if (!filePath) return
    const index = runtime.songsArea.songInfoArr.findIndex((s) => s.filePath === filePath)
    if (index < 0) return
    scrollToIndex(index)
  }

  return {
    scrollToIndex,
    scrollToSong
  }
}
