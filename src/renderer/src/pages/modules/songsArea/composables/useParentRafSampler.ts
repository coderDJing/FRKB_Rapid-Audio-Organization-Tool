import { ref, onMounted, onUnmounted } from 'vue'
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
  let parentRafId = 0

  function startParentRafSampler() {
    cancelAnimationFrame(parentRafId)
    const tick = () => {
      const scrollElements = songsAreaRef.value?.osInstance()?.elements()
      const explicitViewport = scrollElements?.viewport as HTMLElement | undefined
      const explicitHost = scrollElements?.host as HTMLElement | undefined
      const { height, top } = detectSongsAreaScrollCarrier(
        explicitViewport || explicitHost || null,
        explicitHost || null
      )
      if (height > 0) {
        externalScrollTop.value = top
        externalViewportHeight.value = height
      }
      parentRafId = requestAnimationFrame(tick)
    }
    parentRafId = requestAnimationFrame(tick)
  }

  onMounted(() => {
    startParentRafSampler()
  })

  onUnmounted(() => {
    cancelAnimationFrame(parentRafId)
  })

  return { externalScrollTop, externalViewportHeight, startParentRafSampler }
}
