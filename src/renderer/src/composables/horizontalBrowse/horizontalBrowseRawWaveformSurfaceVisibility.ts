import { ref, watch, type Ref } from 'vue'

type SurfaceVisibilityParams = {
  waveformSurfaceRef: Ref<HTMLDivElement | null>
  overlaySurfaceRef: Ref<HTMLDivElement | null>
  syncBufferVisibility: () => void
  clearStableRevisionReplacementState: () => void
  fadeInMs: number
}

export const createHorizontalBrowseRawWaveformSurfaceVisibility = (
  params: SurfaceVisibilityParams
) => {
  const displayReady = ref(false)
  const placeholderVisible = ref(false)
  let displayReadyRevealTimer: ReturnType<typeof setTimeout> | null = null
  let displayReadyRevealGeneration = 0
  let stablePresentationRevealAfterMs = 0
  let stableSurfaceForceHidden = false
  let surfaceVisible: boolean | null = null
  let preserveSurfaceUntilNextReady = false
  let suppressNextSurfaceFadeIn = false

  const clearDisplayReadyRevealTimer = () => {
    if (!displayReadyRevealTimer) return
    clearTimeout(displayReadyRevealTimer)
    displayReadyRevealTimer = null
  }

  const forEachWaveformSurface = (visitor: (element: HTMLDivElement) => void) => {
    for (const element of [params.waveformSurfaceRef.value, params.overlaySurfaceRef.value]) {
      if (element) visitor(element)
    }
  }

  const setWaveformSurfaceVisible = (visible: boolean, fadeIn: boolean) => {
    if (surfaceVisible === visible) return
    surfaceVisible = visible
    forEachWaveformSurface((element) => {
      element.style.transition = visible && fadeIn ? `opacity ${params.fadeInMs}ms linear` : 'none'
      element.style.opacity = visible ? '1' : '0'
    })
  }

  const resolveDisplayReadyForReuse = () => displayReady.value || preserveSurfaceUntilNextReady

  const syncWaveformSurfaceVisibility = (fadeIn: boolean) => {
    setWaveformSurfaceVisible(
      placeholderVisible.value ||
        (!stableSurfaceForceHidden && (displayReady.value || preserveSurfaceUntilNextReady)),
      fadeIn
    )
  }

  const setDisplayReady = (ready: boolean) => {
    if (!ready) {
      clearDisplayReadyRevealTimer()
      displayReadyRevealGeneration += 1
      displayReady.value = false
      if (preserveSurfaceUntilNextReady) return
      params.clearStableRevisionReplacementState()
      syncWaveformSurfaceVisibility(false)
      return
    }
    const nowMs = performance.now()
    const fadeIn = !suppressNextSurfaceFadeIn
    if (fadeIn && nowMs < stablePresentationRevealAfterMs) {
      const generation = displayReadyRevealGeneration + 1
      displayReadyRevealGeneration = generation
      clearDisplayReadyRevealTimer()
      displayReadyRevealTimer = setTimeout(
        () => {
          if (displayReadyRevealGeneration !== generation) return
          displayReadyRevealTimer = null
          stableSurfaceForceHidden = false
          placeholderVisible.value = false
          displayReady.value = true
          params.clearStableRevisionReplacementState()
          syncWaveformSurfaceVisibility(true)
        },
        Math.max(0, stablePresentationRevealAfterMs - nowMs)
      )
      return
    }
    clearDisplayReadyRevealTimer()
    displayReadyRevealGeneration += 1
    stableSurfaceForceHidden = false
    placeholderVisible.value = false
    displayReady.value = true
    params.clearStableRevisionReplacementState()
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
    syncWaveformSurfaceVisibility(fadeIn)
  }

  watch(
    [params.waveformSurfaceRef, params.overlaySurfaceRef],
    () => {
      surfaceVisible = null
      params.syncBufferVisibility()
      syncWaveformSurfaceVisibility(false)
    },
    { flush: 'post' }
  )

  return {
    displayReady,
    placeholderVisible,
    clearDisplayReadyRevealTimer,
    setDisplayReady,
    setWaveformSurfaceVisible,
    syncWaveformSurfaceVisibility,
    resolveDisplayReadyForReuse,
    clearPreservedSurface: () => {
      preserveSurfaceUntilNextReady = false
      suppressNextSurfaceFadeIn = false
    },
    preserveUntilNextReady: () => {
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
    },
    isPreservingSurface: () => preserveSurfaceUntilNextReady,
    setStableSurfaceForceHidden: (value: boolean) => {
      stableSurfaceForceHidden = value
    },
    setStablePresentationRevealAfterMs: (value: number) => {
      stablePresentationRevealAfterMs = value
    }
  }
}
