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
  const TOP_VISIBILITY_MARGIN_PX = 2

  const resolveViewportElement = () => {
    const scrollInstance = songsAreaRef.value?.osInstance()
    return scrollInstance?.elements().viewport as HTMLElement | undefined
  }

  const resolveHeaderOffset = (viewportElement: HTMLElement) => {
    const host = viewportElement.closest('.os-host') as HTMLElement | null
    const header = host?.querySelector('.songListHeader') as HTMLElement | null
    const height = header?.offsetHeight ?? 0
    return Number.isFinite(height) ? height : 0
  }

  const resolveBottomOverlayInset = (viewportElement: HTMLElement) => {
    const viewportRect = viewportElement.getBoundingClientRect()
    const selectors = [
      '.playerArea',
      '.controlsContainer',
      '.playerControlsRoot',
      '.playerControls',
      '.bottom-info-area'
    ]
    const segments: Array<[number, number]> = []
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector)
      for (const el of Array.from(elements)) {
        if (!(el instanceof HTMLElement)) continue
        const rect = el.getBoundingClientRect()
        if (rect.height <= 0 || rect.width <= 0) continue
        const top = Math.max(viewportRect.top, rect.top)
        const bottom = Math.min(viewportRect.bottom, rect.bottom)
        if (bottom <= top) continue
        segments.push([top, bottom])
      }
    }
    if (segments.length === 0) return 0
    segments.sort((a, b) => a[0] - b[0])
    let covered = 0
    let currentStart = segments[0][0]
    let currentEnd = segments[0][1]
    for (let i = 1; i < segments.length; i++) {
      const [start, end] = segments[i]
      if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end)
        continue
      }
      covered += currentEnd - currentStart
      currentStart = start
      currentEnd = end
    }
    covered += currentEnd - currentStart
    return Math.max(0, covered)
  }

  const resolveTopOverlayInset = (viewportElement: HTMLElement) => {
    const viewportRect = viewportElement.getBoundingClientRect()
    const selectors = ['.songListHeader']
    let inset = 0
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector)
      for (const el of Array.from(elements)) {
        if (!(el instanceof HTMLElement)) continue
        const rect = el.getBoundingClientRect()
        if (rect.height <= 0 || rect.width <= 0) continue
        const top = Math.max(viewportRect.top, rect.top)
        const bottom = Math.min(viewportRect.bottom, rect.bottom)
        if (bottom <= top) continue
        const touchesTop = top <= viewportRect.top + 2
        if (!touchesTop) continue
        inset = Math.max(inset, bottom - viewportRect.top)
      }
    }
    return inset
  }

  const resolveSafeAreaMetrics = (viewportElement: HTMLElement) => {
    const viewportRect = viewportElement.getBoundingClientRect()
    const headerOffset = resolveHeaderOffset(viewportElement)
    const topInsetRaw = resolveTopOverlayInset(viewportElement)
    const clampedTopInset = Math.min(topInsetRaw, viewportElement.clientHeight)
    const topVisibilityInset = clampedTopInset + TOP_VISIBILITY_MARGIN_PX
    const bottomInset = resolveBottomOverlayInset(viewportElement)
    const clampedBottomInset = Math.min(bottomInset, viewportElement.clientHeight)
    const safeTop = viewportRect.top + topVisibilityInset
    const safeBottom = viewportRect.bottom - clampedBottomInset
    const safeHeight = Math.max(0, safeBottom - safeTop)
    return {
      headerOffset,
      topInset: clampedTopInset,
      topVisibilityInset,
      bottomInset: clampedBottomInset,
      safeTop,
      safeBottom,
      safeHeight
    }
  }

  const resolveViewportMetrics = (viewportElement: HTMLElement) => {
    const { headerOffset, topVisibilityInset, bottomInset } =
      resolveSafeAreaMetrics(viewportElement)
    const viewTop = viewportElement.scrollTop + topVisibilityInset
    const viewBottom = viewportElement.scrollTop + viewportElement.clientHeight - bottomInset
    const safeHeight = Math.max(0, viewportElement.clientHeight - topVisibilityInset - bottomInset)
    return { headerOffset, topVisibilityInset, bottomInset, viewTop, viewBottom, safeHeight }
  }

  const resolveRowElement = (index: number, viewportElement: HTMLElement) => {
    const song = runtime.songsArea.songInfoArr[index]
    const filePath = song?.filePath
    if (!filePath) return null
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(filePath)
        : filePath.replace(/["\\]/g, '\\$&')
    const selector = `.song-row-item[data-filepath="${escaped}"]`
    return (viewportElement.querySelector(selector) as HTMLElement | null) ?? null
  }

  const isIndexVisible = (index: number, viewportElement: HTMLElement) => {
    const rowEl = resolveRowElement(index, viewportElement)
    if (rowEl) {
      const { safeTop, safeBottom } = resolveSafeAreaMetrics(viewportElement)
      const rect = rowEl.getBoundingClientRect()
      return rect.top >= safeTop && rect.bottom <= safeBottom
    }
    const { headerOffset, viewTop, viewBottom } = resolveViewportMetrics(viewportElement)
    const rowTop = headerOffset + index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    return rowTop >= viewTop && rowBottom <= viewBottom
  }

  const getTargetTop = (
    index: number,
    viewportElement: HTMLElement,
    align: 'center' | 'nearest'
  ) => {
    const rowEl = resolveRowElement(index, viewportElement)
    if (rowEl) {
      const { safeTop, safeBottom, safeHeight } = resolveSafeAreaMetrics(viewportElement)
      const rect = rowEl.getBoundingClientRect()
      const scrollTop = viewportElement.scrollTop
      if (align === 'nearest') {
        if (rect.top < safeTop) return Math.max(0, scrollTop - (safeTop - rect.top))
        if (rect.bottom > safeBottom) return Math.max(0, scrollTop + (rect.bottom - safeBottom))
        return scrollTop
      }
      if (safeHeight <= 0) {
        return Math.max(0, scrollTop + rect.top - safeTop)
      }
      const rowCenter = rect.top + rect.height / 2
      const safeCenter = safeTop + safeHeight / 2
      return Math.max(0, scrollTop + (rowCenter - safeCenter))
    }
    const { headerOffset, topVisibilityInset, bottomInset, viewTop, viewBottom, safeHeight } =
      resolveViewportMetrics(viewportElement)
    const rowTop = headerOffset + index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (align === 'nearest') {
      if (rowTop < viewTop) return Math.max(0, rowTop - topVisibilityInset)
      if (rowBottom > viewBottom) {
        return Math.max(0, rowBottom - (viewportElement.clientHeight - bottomInset))
      }
      return viewportElement.scrollTop
    }
    if (safeHeight <= 0) {
      return Math.max(0, rowTop - viewportElement.clientHeight / 2)
    }
    return Math.max(0, rowTop + ROW_HEIGHT / 2 - topVisibilityInset - safeHeight / 2)
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
