import { computed, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'

type FixedVirtualListOptions = {
  rowHeight: number
  overscan?: number
  fallbackVisibleRows?: number
}

export type FixedVirtualListEntry<T> = {
  item: T
  index: number
}

export function useFixedVirtualList<T>(
  items: Readonly<Ref<readonly T[]>>,
  options: FixedVirtualListOptions
) {
  const rowHeight = Math.max(1, options.rowHeight)
  const overscan = Math.max(0, options.overscan ?? 10)
  const fallbackVisibleRows = Math.max(1, options.fallbackVisibleRows ?? 16)
  const viewport = shallowRef<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewportHeight = ref(0)
  let resizeObserver: ResizeObserver | null = null

  const syncViewportMetrics = () => {
    const element = viewport.value
    if (!element) return
    scrollTop.value = element.scrollTop
    viewportHeight.value = element.clientHeight
  }

  const detachViewport = () => {
    const element = viewport.value
    if (element) {
      element.removeEventListener('scroll', syncViewportMetrics)
    }
    resizeObserver?.disconnect()
    resizeObserver = null
    viewport.value = null
  }

  const attachViewport = (element: HTMLElement | null | undefined) => {
    if (!element) {
      detachViewport()
      return
    }
    if (viewport.value === element) {
      syncViewportMetrics()
      return
    }

    detachViewport()
    viewport.value = element
    element.addEventListener('scroll', syncViewportMetrics, { passive: true })

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(syncViewportMetrics)
      resizeObserver.observe(element)
    }

    syncViewportMetrics()
  }

  const effectiveViewportHeight = computed(
    () => viewportHeight.value || rowHeight * fallbackVisibleRows
  )
  const totalHeight = computed(() => items.value.length * rowHeight)
  const visibleRowCount = computed(() =>
    Math.max(1, Math.ceil(effectiveViewportHeight.value / rowHeight))
  )
  const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscan))
  const endIndex = computed(() =>
    Math.min(items.value.length, startIndex.value + visibleRowCount.value + overscan * 2)
  )
  const offsetTop = computed(() => startIndex.value * rowHeight)
  const visibleEntries = computed<FixedVirtualListEntry<T>[]>(() => {
    const entries: FixedVirtualListEntry<T>[] = []
    for (let index = startIndex.value; index < endIndex.value; index++) {
      const item = items.value[index]
      if (item !== undefined) entries.push({ item, index })
    }
    return entries
  })

  const scrollToIndex = (index: number) => {
    const element = viewport.value
    if (!element || index < 0 || index >= items.value.length) return

    const rowTop = index * rowHeight
    const rowBottom = rowTop + rowHeight
    const viewportTop = element.scrollTop
    const viewportBottom = viewportTop + element.clientHeight

    if (rowTop < viewportTop) {
      element.scrollTop = rowTop
    } else if (rowBottom > viewportBottom) {
      element.scrollTop = rowBottom - element.clientHeight
    }
    syncViewportMetrics()
  }

  const resetScroll = () => {
    scrollTop.value = 0
    if (viewport.value) viewport.value.scrollTop = 0
  }

  watch(
    () => items.value.length,
    () => {
      const element = viewport.value
      if (!element) return
      const maxScrollTop = Math.max(0, totalHeight.value - element.clientHeight)
      if (element.scrollTop > maxScrollTop) {
        element.scrollTop = maxScrollTop
      }
      syncViewportMetrics()
    }
  )

  onUnmounted(detachViewport)

  return {
    viewport,
    totalHeight,
    offsetTop,
    visibleEntries,
    attachViewport,
    syncViewportMetrics,
    scrollToIndex,
    resetScroll
  }
}
