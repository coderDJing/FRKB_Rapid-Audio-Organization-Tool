import {
  compactVisualWaveformToRawData,
  unifiedDisplayWaveformToRawData
} from '@renderer/components/horizontalBrowseCompactVisualWaveform'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type {
  HorizontalBrowseCompactVisualWaveformWorkerIncoming,
  HorizontalBrowseCompactVisualWaveformWorkerOutgoing
} from '@renderer/workers/horizontalBrowseCompactVisualWaveform.types'

const workerScope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  addEventListener: typeof globalThis.addEventListener
}

const collectTransferableBuffers = (data: RawWaveformData | null): Transferable[] => {
  if (!data) return []
  const arrays = [
    data.minLeft,
    data.maxLeft,
    data.minRight,
    data.maxRight,
    data.meanLeft,
    data.meanRight,
    data.rmsLeft,
    data.rmsRight,
    data.compactColorIndex,
    data.compactColorLow,
    data.compactColorMid,
    data.compactColorHigh,
    data.compactColorRed,
    data.compactColorGreen,
    data.compactColorBlue
  ].filter((value): value is Float32Array | Uint8Array => {
    return value instanceof Float32Array || value instanceof Uint8Array
  })
  const buffers = new Set<ArrayBuffer>()
  for (const array of arrays) {
    if (array.buffer instanceof ArrayBuffer) {
      buffers.add(array.buffer)
    }
  }
  return [...buffers]
}

const postWorkerMessage = (
  message: HorizontalBrowseCompactVisualWaveformWorkerOutgoing,
  transfer?: Transferable[]
) => {
  if (transfer?.length) {
    workerScope.postMessage(message, transfer)
    return
  }
  workerScope.postMessage(message)
}

const buildRawData = (
  data: HorizontalBrowseCompactVisualWaveformWorkerIncoming['payload']['data']
) => {
  if ('height' in data) return unifiedDisplayWaveformToRawData(data)
  return compactVisualWaveformToRawData(data)
}

workerScope.addEventListener(
  'message',
  (event: MessageEvent<HorizontalBrowseCompactVisualWaveformWorkerIncoming>) => {
    const message = event.data
    if (message?.type !== 'buildStrip') return
    const token = Math.max(0, Number(message.payload?.token) || 0)
    try {
      const data = buildRawData(message.payload.data)
      postWorkerMessage(
        {
          type: 'stripReady',
          payload: { token, data }
        },
        collectTransferableBuffers(data)
      )
    } catch (error) {
      postWorkerMessage({
        type: 'stripFailed',
        payload: {
          token,
          error: error instanceof Error ? error.message : String(error || 'build strip failed')
        }
      })
    }
  }
)
