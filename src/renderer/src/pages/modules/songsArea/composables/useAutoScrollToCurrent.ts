import { watch, nextTick } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

interface UseAutoScrollParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaRef: { value: OverlayScrollbarsComponentRef }
}

export function useAutoScrollToCurrent(params: UseAutoScrollParams) {
  const { runtime, songsAreaRef } = params

  watch(
    () => runtime.playingData.playingSong,
    (newSong, oldSong) => {
      if (
        runtime.setting.autoScrollToCurrentSong &&
        newSong &&
        newSong.filePath !== oldSong?.filePath &&
        songsAreaRef.value
      ) {
        nextTick(() => {
          const scrollInstance = songsAreaRef.value?.osInstance()
          const viewportElement = scrollInstance?.elements().viewport as HTMLElement | undefined
          if (!viewportElement) return

          const ROW_HEIGHT = 30
          const index = runtime.songsArea.songInfoArr.findIndex(
            (s) => s.filePath === newSong.filePath
          )
          if (index >= 0) {
            const targetTop = index * ROW_HEIGHT
            const centerTop = Math.max(0, targetTop - viewportElement.clientHeight / 2)
            try {
              viewportElement.scrollTo({ top: centerTop, behavior: 'smooth' })
            } catch {
              viewportElement.scrollTop = centerTop
            }
          }
        })
      }
    },
    { deep: true }
  )
}
