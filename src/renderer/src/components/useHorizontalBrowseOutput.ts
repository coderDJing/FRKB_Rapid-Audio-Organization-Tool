import { computed, onMounted, onUnmounted, ref } from 'vue'
import emitter from '@renderer/utils/mitt'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_SET_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  clampVolumeValue,
  readWindowVolume
} from '@renderer/utils/windowVolume'

type UseHorizontalBrowseOutputParams = {
  nativeTransport: {
    state: {
      output?: {
        crossfaderValue?: number
        masterGain?: number
      }
    }
    setOutputState: (crossfaderValue: number, masterGain: number) => Promise<unknown>
  }
}

const FADER_TRAVEL_INSET_RATIO = 0.17
const CROSSFADER_KEY_STEP = 0.25

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const useHorizontalBrowseOutput = ({ nativeTransport }: UseHorizontalBrowseOutputParams) => {
  const faderRef = ref<HTMLElement | null>(null)
  const faderRailRef = ref<HTMLElement | null>(null)
  const faderDragging = ref(false)
  const mainWindowVolume = ref(readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY))

  const resolveCrossfaderTravelPercentByValue = (value: number) => {
    const travelPercent = FADER_TRAVEL_INSET_RATIO * 100
    const usablePercent = 100 - travelPercent * 2
    return travelPercent + (1 - clampNumber(value, -1, 1)) * 0.5 * usablePercent
  }

  const faderTicks = Array.from({ length: 9 }, (_, index) => ({
    id: index,
    top: `${resolveCrossfaderTravelPercentByValue(1 - index / 4)}%`,
    major: index === 0 || index === 4 || index === 8,
    center: index === 4
  }))

  const resolveCrossfaderValue = () =>
    clampNumber(Number(nativeTransport.state.output?.crossfaderValue) || 0, -1, 1)

  const faderThumbStyle = computed(() => ({
    top: `${resolveCrossfaderTravelPercentByValue(resolveCrossfaderValue())}%`
  }))

  const syncCrossfaderValue = (value: number) => {
    const safeValue = clampNumber(value, -1, 1)
    const masterVolume = clampVolumeValue(mainWindowVolume.value)
    void nativeTransport.setOutputState(safeValue, masterVolume)
  }

  const resolveCrossfaderValueByClientY = (clientY: number) => {
    const rect =
      faderRailRef.value?.getBoundingClientRect() || faderRef.value?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return resolveCrossfaderValue()
    const travelInsetPx = rect.height * FADER_TRAVEL_INSET_RATIO
    const travelHeight = Math.max(1, rect.height - travelInsetPx * 2)
    const relativeY = clampNumber(clientY - rect.top - travelInsetPx, 0, travelHeight)
    return 1 - (relativeY / travelHeight) * 2
  }

  const stopFaderDragging = () => {
    if (!faderDragging.value) return
    faderDragging.value = false
    window.removeEventListener('pointermove', handleWindowFaderPointerMove)
    window.removeEventListener('pointerup', handleWindowFaderPointerUp)
    window.removeEventListener('pointercancel', handleWindowFaderPointerUp)
  }

  const handleWindowFaderPointerMove = (event: PointerEvent) => {
    if (!faderDragging.value) return
    syncCrossfaderValue(resolveCrossfaderValueByClientY(event.clientY))
  }

  const handleWindowFaderPointerUp = () => {
    stopFaderDragging()
  }

  const handleFaderPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    faderDragging.value = true
    syncCrossfaderValue(resolveCrossfaderValueByClientY(event.clientY))
    window.addEventListener('pointermove', handleWindowFaderPointerMove)
    window.addEventListener('pointerup', handleWindowFaderPointerUp)
    window.addEventListener('pointercancel', handleWindowFaderPointerUp)
  }

  const handleFaderDoubleClick = () => {
    stopFaderDragging()
    syncCrossfaderValue(0)
  }

  const handleMainWindowVolumeSync = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    mainWindowVolume.value = clampVolumeValue(value)
    void nativeTransport.setOutputState(resolveCrossfaderValue(), mainWindowVolume.value)
  }

  const nudgeCrossfaderByKeyboard = (direction: -1 | 1) => {
    syncCrossfaderValue(resolveCrossfaderValue() + direction * CROSSFADER_KEY_STEP)
  }

  const resetCrossfaderByKeyboard = () => {
    syncCrossfaderValue(0)
  }

  onMounted(() => {
    emitter.on(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSync)
    emitter.on(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
    void nativeTransport.setOutputState(resolveCrossfaderValue(), mainWindowVolume.value)
  })

  onUnmounted(() => {
    emitter.off(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSync)
    emitter.off(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
    stopFaderDragging()
  })

  return {
    faderRef,
    faderRailRef,
    faderTicks,
    faderThumbStyle,
    faderDragging,
    syncCrossfaderValue,
    handleFaderPointerDown,
    handleFaderDoubleClick,
    nudgeCrossfaderByKeyboard,
    resetCrossfaderByKeyboard
  }
}
