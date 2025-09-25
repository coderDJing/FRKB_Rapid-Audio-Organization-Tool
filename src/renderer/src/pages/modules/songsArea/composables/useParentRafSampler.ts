import { ref, onMounted, onUnmounted } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

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
      const vp = songsAreaRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined
      if (vp) {
        externalScrollTop.value = vp.scrollTop
        externalViewportHeight.value = vp.clientHeight
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
