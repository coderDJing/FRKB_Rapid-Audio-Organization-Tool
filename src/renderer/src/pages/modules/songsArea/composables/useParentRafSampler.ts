import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { detectSongsAreaScrollCarrier } from './scrollCarrier'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

interface UseParentRafSamplerParams {
  songsAreaRef: { value: OverlayScrollbarsComponentRef }
}

export function useParentRafSampler(params: UseParentRafSamplerParams) {
  const { songsAreaRef } = params
  const externalScrollTop = ref(0)
  const externalViewportHeight = ref(0)
  let resizeObserver: ResizeObserver | null = null
  let attachedScrollElements: HTMLElement[] = []
  let onScrollBound: (() => void) | null = null
  let attachRetryTimer: ReturnType<typeof setTimeout> | null = null

  const clearAttachRetryTimer = () => {
    if (!attachRetryTimer) return
    clearTimeout(attachRetryTimer)
    attachRetryTimer = null
  }

  const syncMetrics = () => {
    const scrollElements = songsAreaRef.value?.osInstance()?.elements()
    const explicitViewport = scrollElements?.viewport as HTMLElement | undefined
    const explicitHost = scrollElements?.host as HTMLElement | undefined
    const info = detectSongsAreaScrollCarrier(
      explicitViewport || explicitHost || null,
      explicitHost || null
    )
    if (info.height > 0) {
      externalScrollTop.value = info.top
      externalViewportHeight.value = info.height
    }
    return info
  }

  const detachListeners = () => {
    clearAttachRetryTimer()
    if (onScrollBound) {
      for (const element of attachedScrollElements) {
        element.removeEventListener('scroll', onScrollBound)
      }
    }
    attachedScrollElements = []
    onScrollBound = null
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
  }

  const scheduleAttachRetry = (attempt = 0) => {
    if (attachRetryTimer || attempt >= 12) return
    attachRetryTimer = setTimeout(() => {
      attachRetryTimer = null
      if (!startParentRafSampler()) {
        scheduleAttachRetry(attempt + 1)
      }
    }, 120)
  }

  function startParentRafSampler() {
    detachListeners()
    const info = syncMetrics()
    const candidates = [info.carrier, info.viewport, info.content, info.host].filter(
      (element, index, list): element is HTMLElement =>
        element instanceof HTMLElement && list.indexOf(element) === index
    )
    if (!candidates.length) return false

    onScrollBound = () => {
      syncMetrics()
    }
    for (const element of candidates) {
      element.addEventListener('scroll', onScrollBound, { passive: true })
    }
    attachedScrollElements = candidates

    if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => {
        syncMetrics()
      })
      for (const element of candidates) {
        resizeObserver.observe(element)
      }
    }

    return true
  }

  onMounted(() => {
    if (!startParentRafSampler()) {
      void nextTick(() => {
        if (!startParentRafSampler()) {
          scheduleAttachRetry()
        }
      })
    }
  })

  onUnmounted(() => {
    detachListeners()
  })

  watch(
    () => songsAreaRef.value,
    (value) => {
      if (!value) {
        detachListeners()
        return
      }
      if (!startParentRafSampler()) {
        scheduleAttachRetry()
      }
    }
  )

  return { externalScrollTop, externalViewportHeight, startParentRafSampler }
}
