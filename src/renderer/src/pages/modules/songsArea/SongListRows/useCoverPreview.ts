import { computed, onUnmounted, reactive, watch, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

interface UseCoverPreviewOptions {
  songs: Ref<ISongInfo[] | undefined>
  rowsRoot: Ref<HTMLElement | null>
  hostElement: Ref<HTMLElement | null>
  viewportElement: Ref<HTMLElement | null>
  coverCellRefMap: Map<string, HTMLElement | null>
  rowHeight: Ref<number>
  defaultRowHeight: number
  getCoverUrl: (filePath: string) => string | null | undefined
  fetchCoverUrl: (filePath: string) => Promise<string | null>
  effectiveScrollTop: Ref<number>
  scrollLeft: Ref<number>
}

export function useCoverPreview({
  songs,
  rowsRoot,
  hostElement,
  viewportElement,
  coverCellRefMap,
  rowHeight,
  defaultRowHeight,
  getCoverUrl,
  fetchCoverUrl,
  effectiveScrollTop,
  scrollLeft
}: UseCoverPreviewOptions) {
  const songsComputed = computed(() => songs.value ?? [])
  const coverPreviewState = reactive({
    active: false,
    anchorIndex: -1,
    anchorFilePath: '',
    displayIndex: -1,
    overlayLeft: 0,
    overlayTop: 0,
    overlayWidth: 0,
    pointerClientX: 0,
    pointerClientY: 0,
    anchorRectLeft: 0,
    anchorRectTop: 0,
    anchorRectWidth: 0,
    anchorRectHeight: 0
  })
  const coverPreviewSize = computed(() => {
    return coverPreviewState.overlayWidth > 0
      ? coverPreviewState.overlayWidth
      : rowHeight.value || defaultRowHeight
  })
  const previewedSong = computed(() => {
    if (!coverPreviewState.active) return null
    return songsComputed.value[coverPreviewState.displayIndex] ?? null
  })
  const previewedCoverUrl = computed(() => {
    const song = previewedSong.value
    if (!song?.filePath) return null
    const url = getCoverUrl(song.filePath)
    if (url === undefined) {
      fetchCoverUrl(song.filePath)
    }
    return url
  })

  let overlayLeftLock = 0
  let detachPreviewGuards: (() => void) | null = null
  let rafId = 0

  function getListContainerRect(): DOMRect | null {
    const container =
      viewportElement.value ||
      (hostElement.value?.querySelector?.('.os-viewport') as HTMLElement | null) ||
      rowsRoot.value
    return container?.getBoundingClientRect() || null
  }

  function ensurePointerWithinAllowedArea() {
    if (!coverPreviewState.active) return
    const x = coverPreviewState.pointerClientX
    const y = coverPreviewState.pointerClientY
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const rect = getListContainerRect()
    if (rect) {
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        closeCoverPreview()
        return
      }
    }
    const anchorEl = coverPreviewState.anchorFilePath
      ? coverCellRefMap.get(coverPreviewState.anchorFilePath) || null
      : null
    if (!anchorEl) {
      closeCoverPreview()
      return
    }
    const anchorRect = anchorEl.getBoundingClientRect()
    const driftThresholdX = Math.max(coverPreviewState.anchorRectWidth || 0, 20) * 0.2
    const driftThresholdY = Math.max(coverPreviewState.anchorRectHeight || 0, 20) * 0.3
    const driftX = Math.abs(anchorRect.left - coverPreviewState.anchorRectLeft)
    const driftY = Math.abs(anchorRect.top - coverPreviewState.anchorRectTop)
    if (driftX > driftThresholdX || driftY > driftThresholdY) {
      closeCoverPreview()
      return
    }
    const el = document.elementFromPoint(x, y)
    if (!el) {
      closeCoverPreview()
      return
    }
    if (anchorEl.contains(el)) {
      return
    }
    const overlayTarget = el.closest('.cover-preview-overlay')
    if (overlayTarget) {
      return
    }
    closeCoverPreview()
  }

  function attachPreviewGuards() {
    if (typeof window === 'undefined') return
    detachPreviewGuards?.()
    const onPointerMove = (event: MouseEvent) => {
      coverPreviewState.pointerClientX = event.clientX
      coverPreviewState.pointerClientY = event.clientY
      ensurePointerWithinAllowedArea()
    }
    const onGlobalScroll = () => {
      ensurePointerWithinAllowedArea()
    }
    window.addEventListener('mousemove', onPointerMove, true)
    window.addEventListener('scroll', onGlobalScroll, true)
    detachPreviewGuards = () => {
      window.removeEventListener('mousemove', onPointerMove, true)
      window.removeEventListener('scroll', onGlobalScroll, true)
      detachPreviewGuards = null
    }
  }

  function startRafMonitor() {
    if (typeof requestAnimationFrame === 'undefined') return
    const tick = () => {
      if (coverPreviewState.active) {
        ensurePointerWithinAllowedArea()
        rafId = requestAnimationFrame(tick)
      }
    }
    rafId = requestAnimationFrame(tick)
  }

  function stopRafMonitor() {
    if (typeof cancelAnimationFrame === 'undefined') return
    cancelAnimationFrame(rafId)
    rafId = 0
  }

  function applyCoverPreviewRect(rect: DOMRect | null, lockHorizontal = false): boolean {
    if (!rect) return false
    const fallbackSize = rowHeight.value || defaultRowHeight
    const width =
      rect.width && rect.width > 0 ? rect.width : coverPreviewState.overlayWidth || fallbackSize
    coverPreviewState.overlayWidth = width
    if (lockHorizontal || !overlayLeftLock) {
      overlayLeftLock = rect.left
    }
    coverPreviewState.overlayLeft = overlayLeftLock || rect.left
    const effectiveSize = width > 0 ? width : Math.max(fallbackSize, rect.height || 0)
    coverPreviewState.overlayTop = rect.top + rect.height / 2 - effectiveSize / 2
    coverPreviewState.anchorRectLeft = rect.left
    coverPreviewState.anchorRectTop = rect.top
    coverPreviewState.anchorRectWidth = rect.width
    coverPreviewState.anchorRectHeight = rect.height
    return true
  }

  function syncPreviewPositionByIndex(idx: number): boolean {
    const song = songsComputed.value[idx]
    if (!song) return false
    const el = coverCellRefMap.get(song.filePath) || null
    if (!el) return false
    return applyCoverPreviewRect(el.getBoundingClientRect())
  }

  function isPointerOutsideVisibleArea(event: MouseEvent): boolean {
    const rect = getListContainerRect()
    if (!rect) return false
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
  }

  function closeCoverPreview() {
    coverPreviewState.active = false
    coverPreviewState.anchorIndex = -1
    coverPreviewState.anchorFilePath = ''
    coverPreviewState.displayIndex = -1
    coverPreviewState.overlayWidth = 0
    coverPreviewState.overlayLeft = 0
    coverPreviewState.overlayTop = 0
    coverPreviewState.pointerClientX = 0
    coverPreviewState.pointerClientY = 0
    coverPreviewState.anchorRectLeft = 0
    coverPreviewState.anchorRectTop = 0
    coverPreviewState.anchorRectWidth = 0
    coverPreviewState.anchorRectHeight = 0
    overlayLeftLock = 0
    detachPreviewGuards?.()
    stopRafMonitor()
  }

  function onCoverMouseEnter(idx: number, event: MouseEvent) {
    const target = event.currentTarget as HTMLElement | null
    if (!target) return
    const song = songsComputed.value[idx]
    const filePath = song?.filePath
    if (!filePath) {
      closeCoverPreview()
      return
    }
    const cachedCoverUrl = getCoverUrl(filePath)
    if (cachedCoverUrl === null) {
      closeCoverPreview()
      return
    }
    const rect = target.getBoundingClientRect()
    if (coverPreviewState.active) {
      if (coverPreviewState.anchorIndex === idx) {
        return
      }
      closeCoverPreview()
      return
    }
    coverPreviewState.pointerClientX = event.clientX
    coverPreviewState.pointerClientY = event.clientY
    coverPreviewState.active = true
    coverPreviewState.anchorIndex = idx
    coverPreviewState.displayIndex = idx
    coverPreviewState.anchorFilePath = filePath
    applyCoverPreviewRect(rect, true)
    attachPreviewGuards()
    startRafMonitor()
    fetchCoverUrl(filePath)
  }

  function onCoverMouseLeave(idx: number, event: MouseEvent) {
    if (!coverPreviewState.active) return
    const nextTarget = (event?.relatedTarget as HTMLElement | null) || null
    if (nextTarget && nextTarget.closest('.cover-preview-overlay')) {
      return
    }
    if (coverPreviewState.anchorIndex === idx) {
      closeCoverPreview()
    }
  }

  function trySwitchPreviewSong(direction: -1 | 1, pointerClientY: number): boolean {
    if (!coverPreviewState.active) return false
    const total = songsComputed.value.length
    const nextIdx = coverPreviewState.displayIndex + direction
    if (nextIdx < 0 || nextIdx >= total) return false
    coverPreviewState.displayIndex = nextIdx
    if (!syncPreviewPositionByIndex(nextIdx)) {
      coverPreviewState.overlayTop = pointerClientY - coverPreviewSize.value / 2
    }
    const song = songsComputed.value[nextIdx]
    if (song?.filePath) fetchCoverUrl(song.filePath)
    return true
  }

  function handleCoverPreviewMouseMove(event: MouseEvent) {
    if (!coverPreviewState.active) return
    coverPreviewState.pointerClientX = event.clientX
    coverPreviewState.pointerClientY = event.clientY
    if (isPointerOutsideVisibleArea(event)) {
      closeCoverPreview()
      return
    }
    const target = event.currentTarget as HTMLElement | null
    if (!target) return
    const rect = target.getBoundingClientRect()
    if (!rect || rect.height <= 0) return
    const ratio = (event.clientY - rect.top) / rect.height
    const normalized = Math.max(0, Math.min(1, ratio))
    const topThreshold = 1 / 3
    const bottomThreshold = 2 / 3
    if (normalized < topThreshold) {
      if (trySwitchPreviewSong(-1, event.clientY)) return
    } else if (normalized > bottomThreshold) {
      if (trySwitchPreviewSong(1, event.clientY)) return
    }
  }

  watch(
    () => effectiveScrollTop.value,
    () => {
      if (coverPreviewState.active) closeCoverPreview()
    }
  )
  watch(
    () => scrollLeft.value,
    (current, prev) => {
      if (coverPreviewState.active && current !== prev) closeCoverPreview()
    }
  )
  watch(
    () => songsComputed.value,
    () => {
      if (coverPreviewState.active) closeCoverPreview()
    },
    { deep: false }
  )
  watch(
    () => songsComputed.value.length,
    () => {
      if (coverPreviewState.active) closeCoverPreview()
    }
  )
  watch(previewedCoverUrl, (url) => {
    if (coverPreviewState.active && url === null) {
      closeCoverPreview()
    }
  })

  onUnmounted(() => {
    closeCoverPreview()
  })

  return {
    coverPreviewState,
    coverPreviewSize,
    previewedCoverUrl,
    onCoverMouseEnter,
    onCoverMouseLeave,
    handleCoverPreviewMouseMove,
    closeCoverPreview
  }
}
