import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import emitter from '@renderer/utils/mitt'
import {
  registerTitleAudioVisualizerSource,
  unregisterTitleAudioVisualizerSource,
  type TitleAudioVisualizerAnalyserLike,
  type TitleAudioVisualizerSource
} from '@renderer/composables/titleAudioVisualizerBridge'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_SET_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  clampVolumeValue,
  readWindowVolume
} from '@renderer/utils/windowVolume'

type DeckKey = HorizontalBrowseDeckKey

type HorizontalBrowseVisualizerSnapshot = {
  timeDomainData?: unknown
}

type UseHorizontalBrowseOutputParams = {
  nativeTransport: {
    setGain: (deck: DeckKey, gain: number) => Promise<unknown>
    visualizerSnapshot: () => Promise<HorizontalBrowseVisualizerSnapshot | null | undefined>
  }
}

const FADER_TRAVEL_INSET_RATIO = 0.17
const CROSSFADER_KEY_STEP = 0.25
const VISUALIZER_FFT_SIZE = 256
const VISUALIZER_FREQUENCY_BIN_COUNT = VISUALIZER_FFT_SIZE / 2
const VISUALIZER_SNAPSHOT_POLL_MS = 50
const VISUALIZER_SOURCE_PRIORITY = 100

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const copyUint8Array = (source: Uint8Array, target: Uint8Array) => {
  const copyLength = Math.min(source.length, target.length)
  target.fill(0)
  if (copyLength <= 0) return
  target.set(source.subarray(0, copyLength), 0)
}

const resolveByteArray = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(
      value.map((item) => {
        const numeric = Number(item)
        return clampByte(Number.isFinite(numeric) ? numeric : 128)
      })
    )
  }
  return new Uint8Array(0)
}

export const useHorizontalBrowseOutput = ({ nativeTransport }: UseHorizontalBrowseOutputParams) => {
  const faderRef = ref<HTMLElement | null>(null)
  const faderRailRef = ref<HTMLElement | null>(null)
  const faderDragging = ref(false)
  const faderValue = ref(0)
  const mainWindowVolume = ref(readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY))

  let visualizerPollTimer: number | null = null
  let visualizerPollActive = false
  let visualizerPollStopped = false
  const syntheticTimeDomainData = new Uint8Array(VISUALIZER_FFT_SIZE).fill(128)
  const syntheticFrequencyData = new Uint8Array(VISUALIZER_FREQUENCY_BIN_COUNT)
  const scratchTimeDomainData = new Uint8Array(VISUALIZER_FFT_SIZE)

  const syntheticAnalyser: TitleAudioVisualizerAnalyserLike = {
    fftSize: VISUALIZER_FFT_SIZE,
    get frequencyBinCount() {
      return VISUALIZER_FREQUENCY_BIN_COUNT
    },
    getByteFrequencyData(target: Uint8Array) {
      copyUint8Array(syntheticFrequencyData, target)
    },
    getByteTimeDomainData(target: Uint8Array) {
      copyUint8Array(syntheticTimeDomainData, target)
    }
  }

  const titleAudioVisualizerSource: TitleAudioVisualizerSource = {
    getAnalyser: () => syntheticAnalyser,
    priority: VISUALIZER_SOURCE_PRIORITY
  }

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

  const faderThumbStyle = computed(() => ({
    top: `${resolveCrossfaderTravelPercentByValue(faderValue.value)}%`
  }))

  const resolveCrossfaderVolumes = (value: number) => {
    const safeValue = clampNumber(value, -1, 1)
    if (safeValue >= 0) {
      return {
        top: 1,
        bottom: 1 - safeValue
      }
    }
    return {
      top: 1 + safeValue,
      bottom: 1
    }
  }

  const applyDeckOutputGains = (value = faderValue.value) => {
    const deckVolumes = resolveCrossfaderVolumes(value)
    const masterVolume = clampVolumeValue(mainWindowVolume.value)
    void nativeTransport.setGain('top', deckVolumes.top * masterVolume)
    void nativeTransport.setGain('bottom', deckVolumes.bottom * masterVolume)
  }

  const syncCrossfaderValue = (value: number) => {
    faderValue.value = clampNumber(value, -1, 1)
    applyDeckOutputGains(faderValue.value)
  }

  const resolveCrossfaderValueByClientY = (clientY: number) => {
    const rect =
      faderRailRef.value?.getBoundingClientRect() || faderRef.value?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return faderValue.value
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

  const updateSyntheticFrequencyData = () => {
    const maxBinIndex = Math.max(1, syntheticFrequencyData.length - 1)
    for (let binIndex = 0; binIndex < syntheticFrequencyData.length; binIndex += 1) {
      const start = Math.floor(
        (binIndex * syntheticTimeDomainData.length) / syntheticFrequencyData.length
      )
      const end = Math.max(
        start + 1,
        Math.floor(
          ((binIndex + 1) * syntheticTimeDomainData.length) / syntheticFrequencyData.length
        )
      )
      let average = 0
      let peak = 0
      for (let index = start; index < end; index += 1) {
        const centered = Math.abs((syntheticTimeDomainData[index] - 128) / 127)
        average += centered
        if (centered > peak) peak = centered
      }
      const normalizedAverage = average / Math.max(1, end - start)
      const normalized = Math.min(1, normalizedAverage * 0.72 + peak * 0.28)
      const lowBandBoost = 1.16 - (binIndex / maxBinIndex) * 0.24
      syntheticFrequencyData[binIndex] = clampByte(normalized * lowBandBoost * 255)
    }
  }

  const updateSyntheticVisualizerData = (snapshot?: HorizontalBrowseVisualizerSnapshot | null) => {
    scratchTimeDomainData.fill(128)
    const raw = resolveByteArray(snapshot?.timeDomainData)
    if (!raw.length) {
      syntheticTimeDomainData.set(scratchTimeDomainData)
      updateSyntheticFrequencyData()
      return
    }
    const copyLength = Math.min(raw.length, scratchTimeDomainData.length)
    const offset = scratchTimeDomainData.length - copyLength
    for (let index = 0; index < copyLength; index += 1) {
      scratchTimeDomainData[offset + index] = raw[raw.length - copyLength + index] ?? 128
    }
    syntheticTimeDomainData.set(scratchTimeDomainData)
    updateSyntheticFrequencyData()
  }

  const scheduleVisualizerPoll = () => {
    if (visualizerPollStopped) return
    visualizerPollTimer = window.setTimeout(() => {
      void pollVisualizerSnapshot()
    }, VISUALIZER_SNAPSHOT_POLL_MS)
  }

  const pollVisualizerSnapshot = async () => {
    if (visualizerPollStopped || visualizerPollActive) return
    visualizerPollActive = true
    try {
      const snapshot = await nativeTransport.visualizerSnapshot()
      updateSyntheticVisualizerData(snapshot)
    } catch {
      updateSyntheticVisualizerData(null)
    } finally {
      visualizerPollActive = false
      scheduleVisualizerPoll()
    }
  }

  const stopVisualizerPolling = () => {
    visualizerPollStopped = true
    if (visualizerPollTimer !== null) {
      window.clearTimeout(visualizerPollTimer)
      visualizerPollTimer = null
    }
  }

  const handleMainWindowVolumeSync = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    mainWindowVolume.value = clampVolumeValue(value)
    applyDeckOutputGains()
  }

  const nudgeCrossfaderByKeyboard = (direction: -1 | 1) => {
    syncCrossfaderValue(faderValue.value + direction * CROSSFADER_KEY_STEP)
  }

  const resetCrossfaderByKeyboard = () => {
    syncCrossfaderValue(0)
  }

  onMounted(() => {
    registerTitleAudioVisualizerSource('mainWindow', titleAudioVisualizerSource)
    emitter.on(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSync)
    emitter.on(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
    updateSyntheticVisualizerData(null)
    scheduleVisualizerPoll()
  })

  onUnmounted(() => {
    unregisterTitleAudioVisualizerSource('mainWindow', titleAudioVisualizerSource)
    emitter.off(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSync)
    emitter.off(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
    stopVisualizerPolling()
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
