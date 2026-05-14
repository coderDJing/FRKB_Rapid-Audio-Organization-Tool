import { onMounted, onUnmounted } from 'vue'
import {
  registerTitleAudioVisualizerSource,
  unregisterTitleAudioVisualizerSource,
  type TitleAudioVisualizerAnalyserLike,
  type TitleAudioVisualizerSource
} from '@renderer/composables/titleAudioVisualizerBridge'

type HorizontalBrowseVisualizerSnapshot = {
  timeDomainData?: unknown
}

type UseHorizontalBrowseVisualizerParams = {
  nativeTransport: {
    visualizerSnapshot: () => Promise<HorizontalBrowseVisualizerSnapshot | null | undefined>
  }
}

const VISUALIZER_FFT_SIZE = 256
const VISUALIZER_FREQUENCY_BIN_COUNT = VISUALIZER_FFT_SIZE / 2
const VISUALIZER_SNAPSHOT_POLL_MS = 50
const VISUALIZER_SOURCE_PRIORITY = 100

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

export const useHorizontalBrowseVisualizer = ({
  nativeTransport
}: UseHorizontalBrowseVisualizerParams) => {
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

  onMounted(() => {
    registerTitleAudioVisualizerSource('mainWindow', titleAudioVisualizerSource)
    updateSyntheticVisualizerData(null)
    scheduleVisualizerPoll()
  })

  onUnmounted(() => {
    unregisterTitleAudioVisualizerSource('mainWindow', titleAudioVisualizerSource)
    stopVisualizerPolling()
  })
}
