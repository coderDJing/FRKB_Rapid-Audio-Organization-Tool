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
  const SCROLL_TOLERANCE_PX = 2

  const resolveViewportElement = () => {
    const scrollInstance = songsAreaRef.value?.osInstance()
    return scrollInstance?.elements().viewport as HTMLElement | undefined
  }

  const isIndexVisible = (index: number, viewportElement: HTMLElement) => {
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    const viewTop = viewportElement.scrollTop
    const viewBottom = viewTop + viewportElement.clientHeight
    return rowBottom >= viewTop && rowTop <= viewBottom
  }

  const getTargetTop = (
    index: number,
    viewportElement: HTMLElement,
    align: 'center' | 'nearest'
  ) => {
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (align === 'nearest') {
      if (rowTop < viewportElement.scrollTop) return rowTop
      if (rowBottom > viewportElement.scrollTop + viewportElement.clientHeight) {
        return Math.max(0, rowBottom - viewportElement.clientHeight)
      }
      return viewportElement.scrollTop
    }
    return Math.max(0, rowTop - viewportElement.clientHeight / 2)
  }

  const runScroll = (
    index: number,
    options?: {
      behavior?: ScrollBehavior
      align?: 'center' | 'nearest'
      onlyIfNeeded?: boolean
    }
  ) => {
    if (!Number.isFinite(index) || index < 0) return
    const viewportElement = resolveViewportElement()
    if (!viewportElement) return

    const align = options?.align ?? 'center'
    if (options?.onlyIfNeeded && isIndexVisible(index, viewportElement)) return

    const targetTop = getTargetTop(index, viewportElement, align)
    if (Math.abs(viewportElement.scrollTop - targetTop) <= SCROLL_TOLERANCE_PX) return
    try {
      viewportElement.scrollTo({ top: targetTop, behavior: options?.behavior ?? 'smooth' })
    } catch {
      viewportElement.scrollTop = targetTop
    }
  }

  const scrollToIndex = (index: number, behavior: ScrollBehavior = 'smooth') => {
    if (!songsAreaRef.value) return
    nextTick(() => runScroll(index, { behavior, align: 'center' }))
  }

  const scrollToIndexIfNeeded = (index: number, align: 'center' | 'nearest' = 'center') => {
    if (!songsAreaRef.value) return
    nextTick(() => runScroll(index, { onlyIfNeeded: true, align }))
  }

  const scrollToSong = (filePath?: string | null) => {
    if (!filePath) return
    const index = runtime.songsArea.songInfoArr.findIndex((s) => s.filePath === filePath)
    if (index < 0) return
    scrollToIndex(index)
  }

  return {
    scrollToIndex,
    scrollToIndexIfNeeded,
    scrollToSong
  }
}
