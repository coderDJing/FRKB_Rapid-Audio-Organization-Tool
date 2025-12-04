import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

interface UseVirtualRowsOptions {
  songs: Ref<ISongInfo[] | undefined>
  scrollHostElement?: Ref<HTMLElement | null | undefined>
  externalScrollTop?: Ref<number | undefined>
  externalViewportHeight?: Ref<number | undefined>
}

export function useVirtualRows({
  songs,
  scrollHostElement,
  externalScrollTop,
  externalViewportHeight
}: UseVirtualRowsOptions) {
  const rowsRoot = ref<HTMLElement | null>(null)
  const viewportElement = ref<HTMLElement | null>(null)
  const hostElement = ref<HTMLElement | null>(null)
  const defaultRowHeight = 30
  const rowHeight = ref(defaultRowHeight)
  const BUFFER_ROWS = 12
  const scrollTop = ref(0)
  const scrollLeft = ref(0)
  const viewportHeight = ref(0)
  const songsComputed = computed(() => songs.value ?? [])
  const totalHeight = computed(() => songsComputed.value.length * rowHeight.value)

  function measureRowHeight() {
    const root = rowsRoot.value
    if (!root) return
    const el = root.querySelector('.song-row-content') as HTMLElement | null
    const h = el?.offsetHeight
    if (h && h > 0 && h !== rowHeight.value) {
      rowHeight.value = h
    }
  }

  let onScrollBound: ((e: Event) => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let rafId = 0
  let lastScrollTop = -1
  let lastScrollLeft = -1

  function getScrollHostCandidate(): HTMLElement | null | undefined {
    return scrollHostElement ? scrollHostElement.value : undefined
  }

  function resolveViewportEl(): HTMLElement | null {
    const explicitHost = getScrollHostCandidate()
    if (explicitHost instanceof HTMLElement) {
      const host = explicitHost.closest('.os-host') as HTMLElement | null
      hostElement.value = host || null
      const content = host?.querySelector('.os-content') as HTMLElement | null
      if (explicitHost.scrollHeight > explicitHost.clientHeight + 1) return explicitHost
      if (content && content.scrollHeight > content.clientHeight + 1) return content
      return explicitHost
    }
    const root = rowsRoot.value
    if (!root) return null
    const host = root.closest('.os-host') as HTMLElement | null
    hostElement.value = host || null
    const vp = host?.querySelector('.os-viewport') as HTMLElement | null
    const content = host?.querySelector('.os-content') as HTMLElement | null
    if (vp && vp.scrollHeight > vp.clientHeight + 1) return vp
    if (content && content.scrollHeight > content.clientHeight + 1) return content
    return vp || content || host || null
  }

  function detectScrollCarrier(): {
    el: HTMLElement | null
    height: number
    top: number
    left: number
  } {
    const host =
      hostElement.value ||
      rowsRoot.value?.closest?.('.os-host') ||
      viewportElement.value?.closest?.('.os-host') ||
      null
    const vp = (host as HTMLElement | null)?.querySelector?.('.os-viewport') as HTMLElement | null
    const content = (host as HTMLElement | null)?.querySelector?.(
      '.os-content'
    ) as HTMLElement | null
    const candidates: HTMLElement[] = []
    if (viewportElement.value) candidates.push(viewportElement.value)
    if (vp && !candidates.includes(vp)) candidates.push(vp)
    if (content && !candidates.includes(content)) candidates.push(content)
    if (host && !candidates.includes(host)) candidates.push(host as HTMLElement)
    for (const el of candidates) {
      const h = el.clientHeight
      const sh = el.scrollHeight
      if (h > 0 && sh > h + 1) {
        return { el, height: h, top: el.scrollTop, left: el.scrollLeft || 0 }
      }
    }
    const fallback = viewportElement.value || vp || content || (host as HTMLElement | null)
    return {
      el: fallback,
      height: fallback?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0),
      top: fallback?.scrollTop || 0,
      left: fallback?.scrollLeft || 0
    }
  }

  function attachListeners() {
    viewportElement.value = resolveViewportEl()
    if (!viewportElement.value) return
    const initCarrier = detectScrollCarrier()
    viewportHeight.value = initCarrier.height
    scrollTop.value = initCarrier.top
    scrollLeft.value = initCarrier.left ?? 0
    lastScrollLeft = scrollLeft.value

    onScrollBound = () => {
      const carrier = detectScrollCarrier()
      scrollTop.value = carrier.top
      viewportHeight.value = carrier.height
      scrollLeft.value = carrier.left ?? 0
    }
    viewportElement.value.addEventListener('scroll', onScrollBound, { passive: true })

    const host = hostElement.value
    const vp = host?.querySelector('.os-viewport') as HTMLElement | null
    const content = host?.querySelector('.os-content') as HTMLElement | null
    if (vp && vp !== viewportElement.value)
      vp.addEventListener('scroll', onScrollBound, { passive: true })
    if (content && content !== viewportElement.value)
      content.addEventListener('scroll', onScrollBound, { passive: true })

    if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => {
        const carrier = detectScrollCarrier()
        viewportHeight.value = carrier.height
      })
      if (viewportElement.value) resizeObserver.observe(viewportElement.value)
      if (vp && vp !== viewportElement.value) resizeObserver.observe(vp)
      if (content && content !== viewportElement.value) resizeObserver.observe(content)
    }

    const tick = () => {
      const carrier = detectScrollCarrier()
      const st = carrier.top
      const sl = carrier.left ?? 0
      if (st !== lastScrollTop) {
        lastScrollTop = st
        scrollTop.value = st
        viewportHeight.value = carrier.height
        measureRowHeight()
      }
      if (sl !== lastScrollLeft) {
        lastScrollLeft = sl
        scrollLeft.value = sl
      }
      rafId = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(tick) : 0
    }
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId)
    rafId = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(tick) : 0
  }

  function detachListeners() {
    if (viewportElement.value && onScrollBound) {
      viewportElement.value.removeEventListener('scroll', onScrollBound)
    }
    onScrollBound = null
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId)
    if (resizeObserver && viewportElement.value) {
      try {
        resizeObserver.unobserve(viewportElement.value)
      } catch {}
    }
    resizeObserver = null
    viewportElement.value = null
  }

  onMounted(() => {
    attachListeners()
    nextTick(() => {
      if (!viewportElement.value) attachListeners()
    })
  })

  onUnmounted(() => {
    detachListeners()
  })

  watch(
    () => getScrollHostCandidate(),
    () => {
      detachListeners()
      nextTick(() => attachListeners())
    }
  )

  const effectiveScrollTop = computed(() => {
    const externalTop = externalScrollTop ? externalScrollTop.value : undefined
    return typeof externalTop === 'number' ? externalTop : scrollTop.value
  })
  const effectiveViewportHeight = computed(() => {
    const externalHeight = externalViewportHeight ? externalViewportHeight.value : undefined
    return typeof externalHeight === 'number' ? externalHeight : viewportHeight.value
  })

  const startIndex = computed(() => {
    const raw = Math.floor(effectiveScrollTop.value / rowHeight.value) - BUFFER_ROWS
    return Math.max(0, raw)
  })
  const visibleCount = computed(() => {
    const vh =
      effectiveViewportHeight.value && effectiveViewportHeight.value > 0
        ? effectiveViewportHeight.value
        : rowsRoot.value?.parentElement?.clientHeight ||
          (typeof window !== 'undefined' ? window.innerHeight : 0)
    const base = Math.ceil(vh / rowHeight.value) + BUFFER_ROWS * 2
    return Math.max(base, BUFFER_ROWS * 2 + 1)
  })
  const endIndex = computed(() => {
    return Math.min(songsComputed.value.length, startIndex.value + visibleCount.value)
  })
  const offsetTopPx = computed(() => startIndex.value * rowHeight.value)
  const visibleSongsWithIndex = computed(() => {
    const out: { song: ISongInfo; idx: number }[] = []
    const arr = songsComputed.value || []
    for (let i = startIndex.value; i < endIndex.value; i++) {
      const song = arr[i]
      if (song) out.push({ song, idx: i })
    }
    return out
  })

  return {
    rowsRoot,
    hostElement,
    viewportElement,
    visibleSongsWithIndex,
    offsetTopPx,
    totalHeight,
    rowHeight,
    effectiveScrollTop,
    effectiveViewportHeight,
    startIndex,
    endIndex,
    visibleCount,
    scrollLeft
  }
}
