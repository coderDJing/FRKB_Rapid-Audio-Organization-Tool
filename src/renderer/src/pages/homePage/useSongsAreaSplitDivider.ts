import type { ComputedRef } from 'vue'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

const SONGS_AREA_SPLIT_MIN_PANE_WIDTH = 100
const SONGS_AREA_SPLIT_RESIZE_BODY_CLASS = 'songs-area-split-resizing'

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

type UseSongsAreaSplitDividerParams = {
  runtime: RuntimeStore
  isSongsAreaSplit: ComputedRef<boolean>
  persistLayoutConfig: () => void
}

export const useSongsAreaSplitDivider = (params: UseSongsAreaSplitDividerParams) => {
  const splitSongsAreaRef = ref<HTMLDivElement | null>(null)
  const splitSongsAreaWidth = ref(0)
  const splitDividerHovered = ref(false)
  const isSongsAreaSplitDividerResizing = ref(false)

  let splitSongsAreaResizeObserver: ResizeObserver | null = null
  let splitResizeStartX = 0
  let splitResizeStartLeftWidth = 0

  const normalizeSongsAreaSplitRatio = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? clampNumber(parsed, 0, 1) : 0.5
  }

  const clampSongsAreaSplitRatio = (ratio: unknown, width = splitSongsAreaWidth.value) => {
    const normalized = normalizeSongsAreaSplitRatio(ratio)
    const safeWidth = Math.max(0, Number(width) || 0)
    if (safeWidth <= SONGS_AREA_SPLIT_MIN_PANE_WIDTH * 2) return 0.5
    const minRatio = SONGS_AREA_SPLIT_MIN_PANE_WIDTH / safeWidth
    return clampNumber(normalized, minRatio, 1 - minRatio)
  }

  const resolveSongsAreaSplitLeftWidth = (width = splitSongsAreaWidth.value) => {
    const safeWidth = Math.max(0, Number(width) || 0)
    if (!safeWidth) return 0
    return Math.round(
      safeWidth *
        clampSongsAreaSplitRatio(params.runtime.layoutConfig.songsAreaSplitLeftRatio, safeWidth)
    )
  }

  const splitSongsAreaStyle = computed(() => {
    const width = splitSongsAreaWidth.value
    if (width <= 0) {
      return {
        '--songs-area-split-left-width': '50%',
        '--songs-area-split-right-width': '50%',
        '--songs-area-split-divider-left': '50%'
      }
    }
    const leftWidth = resolveSongsAreaSplitLeftWidth(width)
    const rightWidth = Math.max(0, width - leftWidth)
    return {
      '--songs-area-split-left-width': `${leftWidth}px`,
      '--songs-area-split-right-width': `${rightWidth}px`,
      '--songs-area-split-divider-left': `${leftWidth}px`
    }
  })

  const syncSongsAreaSplitWidth = () => {
    const width = splitSongsAreaRef.value?.getBoundingClientRect().width || 0
    splitSongsAreaWidth.value = Math.max(0, width)
  }

  const disconnectSongsAreaSplitObserver = () => {
    splitSongsAreaResizeObserver?.disconnect()
    splitSongsAreaResizeObserver = null
  }

  const applySongsAreaSplitLeftWidth = (leftWidth: number, width: number) => {
    const safeWidth = Math.max(0, Number(width) || 0)
    if (!safeWidth) return
    if (safeWidth <= SONGS_AREA_SPLIT_MIN_PANE_WIDTH * 2) {
      params.runtime.layoutConfig.songsAreaSplitLeftRatio = 0.5
      return
    }
    const safeLeftWidth = clampNumber(
      leftWidth,
      SONGS_AREA_SPLIT_MIN_PANE_WIDTH,
      safeWidth - SONGS_AREA_SPLIT_MIN_PANE_WIDTH
    )
    params.runtime.layoutConfig.songsAreaSplitLeftRatio = clampNumber(
      safeLeftWidth / safeWidth,
      0,
      1
    )
  }

  const handleSongsAreaSplitResizeMove = (event: MouseEvent) => {
    if (!isSongsAreaSplitDividerResizing.value) return
    event.preventDefault()
    const width =
      splitSongsAreaRef.value?.getBoundingClientRect().width || splitSongsAreaWidth.value
    splitSongsAreaWidth.value = Math.max(0, width)
    applySongsAreaSplitLeftWidth(
      splitResizeStartLeftWidth + event.clientX - splitResizeStartX,
      width
    )
  }

  const stopSongsAreaSplitResize = () => {
    if (!isSongsAreaSplitDividerResizing.value) return
    isSongsAreaSplitDividerResizing.value = false
    splitDividerHovered.value = false
    document.removeEventListener('mousemove', handleSongsAreaSplitResizeMove)
    document.removeEventListener('mouseup', stopSongsAreaSplitResize)
    window.removeEventListener('blur', stopSongsAreaSplitResize)
    document.body.classList.remove(SONGS_AREA_SPLIT_RESIZE_BODY_CLASS)
    params.persistLayoutConfig()
  }

  const startSongsAreaSplitResize = (event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    syncSongsAreaSplitWidth()
    const width = splitSongsAreaWidth.value
    if (!width) return
    splitResizeStartX = event.clientX
    splitResizeStartLeftWidth = resolveSongsAreaSplitLeftWidth(width)
    isSongsAreaSplitDividerResizing.value = true
    splitDividerHovered.value = true
    document.body.classList.add(SONGS_AREA_SPLIT_RESIZE_BODY_CLASS)
    document.addEventListener('mousemove', handleSongsAreaSplitResizeMove)
    document.addEventListener('mouseup', stopSongsAreaSplitResize)
    window.addEventListener('blur', stopSongsAreaSplitResize)
  }

  const scheduleSongsAreaSplitObserver = () => {
    disconnectSongsAreaSplitObserver()
    if (!params.isSongsAreaSplit.value) {
      splitSongsAreaWidth.value = 0
      splitDividerHovered.value = false
      stopSongsAreaSplitResize()
      return
    }
    void nextTick().then(() => {
      const element = splitSongsAreaRef.value
      if (!element || !params.isSongsAreaSplit.value) return
      syncSongsAreaSplitWidth()
      splitSongsAreaResizeObserver = new ResizeObserver(syncSongsAreaSplitWidth)
      splitSongsAreaResizeObserver.observe(element)
    })
  }

  watch(
    () => params.isSongsAreaSplit.value,
    () => scheduleSongsAreaSplitObserver(),
    { immediate: true, flush: 'post' }
  )

  onUnmounted(() => {
    stopSongsAreaSplitResize()
    disconnectSongsAreaSplitObserver()
    document.body.classList.remove(SONGS_AREA_SPLIT_RESIZE_BODY_CLASS)
  })

  return {
    splitSongsAreaRef,
    splitSongsAreaStyle,
    splitDividerHovered,
    isSongsAreaSplitDividerResizing,
    startSongsAreaSplitResize
  }
}
