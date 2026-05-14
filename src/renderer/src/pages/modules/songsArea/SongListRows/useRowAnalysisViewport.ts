import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

type UseRowAnalysisViewportParams = {
  rowsRoot: Ref<HTMLElement | null>
  viewportElement: Ref<HTMLElement | null>
  scrollHostElement: Ref<HTMLElement | null | undefined>
}

export function useRowAnalysisViewport({
  rowsRoot,
  viewportElement,
  scrollHostElement
}: UseRowAnalysisViewportParams) {
  const listViewportWidth = ref(0)
  let resizeObserver: ResizeObserver | null = null

  const resolveViewport = () => {
    const explicit = scrollHostElement.value
    if (explicit instanceof HTMLElement) return explicit

    const virtualViewport = viewportElement.value
    if (virtualViewport instanceof HTMLElement) return virtualViewport

    const host = rowsRoot.value?.closest('.os-host') as HTMLElement | null
    const viewport = host?.querySelector('.os-viewport') as HTMLElement | null
    return viewport || rowsRoot.value
  }

  const updateWidth = () => {
    const viewport = resolveViewport()
    listViewportWidth.value = Math.max(0, Math.floor(viewport?.clientWidth || 0))
  }

  const observeWidth = () => {
    resizeObserver?.disconnect()
    resizeObserver = null

    const viewport = resolveViewport()
    if (!viewport) {
      listViewportWidth.value = 0
      return
    }

    updateWidth()
    resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(viewport)
  }

  const scheduleObserveWidth = () => {
    nextTick(observeWidth)
  }

  onMounted(scheduleObserveWidth)

  watch(() => rowsRoot.value, scheduleObserveWidth)
  watch(() => viewportElement.value, scheduleObserveWidth)
  watch(() => scrollHostElement.value, scheduleObserveWidth)

  onUnmounted(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return {
    listViewportWidth
  }
}
