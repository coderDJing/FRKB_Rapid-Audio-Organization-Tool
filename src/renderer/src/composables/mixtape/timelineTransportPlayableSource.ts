export type TransportPlaybackRateControl = {
  value: number
  setTargetAtTime: (value: number, startTime: number, timeConstant: number) => void
}

export type TransportPlayableSource = {
  buffer: AudioBuffer | null
  playbackRate: TransportPlaybackRateControl
  onended: (() => void) | null
  connect: (destination: AudioNode) => void
  disconnect: () => void
  start: (when?: number, offset?: number) => void
  stop: (when?: number) => void
}

const WORKLET_NAME = 'mixtape-transport-keylock'

type TransportPlayableAudioContext = BaseAudioContext & {
  createBufferSource: () => AudioBufferSourceNode
  audioWorklet?: AudioWorklet
}

type KeyLockWorkletMessage =
  | {
      type: 'position'
      frame?: number
    }
  | {
      type: 'ended'
    }

const workletModuleByContext = new WeakMap<TransportPlayableAudioContext, Promise<void>>()

const cloneBufferChannels = (buffer: AudioBuffer) => {
  const channels: Float32Array[] = []
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
    const sourceIndex = Math.min(buffer.numberOfChannels - 1, channelIndex)
    channels.push(new Float32Array(buffer.getChannelData(Math.max(0, sourceIndex))))
  }
  return channels
}

export const ensureTransportKeyLockWorkletModule = async (
  audioCtx: TransportPlayableAudioContext
) => {
  if (!audioCtx.audioWorklet) {
    throw new Error('AudioWorklet is unavailable')
  }
  const existing = workletModuleByContext.get(audioCtx)
  if (existing) {
    await existing
    return
  }
  // @ts-expect-error Vite resolves import.meta.url in renderer build
  const moduleUrl = new URL('../../workers/mixtapeTransportKeyLock.worklet.js', import.meta.url)
  const task = audioCtx.audioWorklet.addModule(moduleUrl.href)
  workletModuleByContext.set(audioCtx, task)
  await task
}

export const createTransportBufferSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer
): TransportPlayableSource => {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  return source as unknown as TransportPlayableSource
}

export const createTransportKeyLockSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer
): TransportPlayableSource => {
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  const node = new AudioWorkletNode(audioCtx, WORKLET_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [outputChannels]
  })
  const channels = cloneBufferChannels(buffer)
  node.port.postMessage(
    {
      type: 'set-source',
      channels,
      sampleRate: buffer.sampleRate,
      frameCount: buffer.length,
      outputChannels
    },
    channels.map((channel) => channel.buffer)
  )

  let endedHandler: (() => void) | null = null
  const playbackRate: TransportPlaybackRateControl = {
    value: 1,
    setTargetAtTime(value: number, startTime: number, timeConstant: number) {
      playbackRate.value = Number(value) || 1
      node.port.postMessage({
        type: 'set-rate',
        rate: playbackRate.value,
        startTimeSec: Number(startTime) || audioCtx.currentTime,
        timeConstant: Number(timeConstant) || 0.04
      })
    }
  }

  node.port.onmessage = (event: MessageEvent<KeyLockWorkletMessage>) => {
    const data = event.data
    if (!data || data.type !== 'ended') return
    endedHandler?.()
  }

  return {
    buffer,
    playbackRate,
    get onended() {
      return endedHandler
    },
    set onended(handler: (() => void) | null) {
      endedHandler = typeof handler === 'function' ? handler : null
    },
    connect(destination: AudioNode) {
      node.connect(destination)
    },
    disconnect() {
      try {
        node.port.onmessage = null
      } catch {}
      try {
        node.disconnect()
      } catch {}
    },
    start(when?: number, offset?: number) {
      const startTimeSec = Number.isFinite(Number(when))
        ? Math.max(audioCtx.currentTime, Number(when))
        : audioCtx.currentTime
      const safeOffset = Math.max(0, Number(offset) || 0)
      node.port.postMessage({
        type: 'start',
        startTimeSec,
        startFrame: safeOffset * buffer.sampleRate,
        rate: playbackRate.value
      })
    },
    stop(when?: number) {
      const stopTimeSec =
        Number.isFinite(Number(when)) && Number(when) > audioCtx.currentTime
          ? Number(when)
          : audioCtx.currentTime
      node.port.postMessage({
        type: 'stop',
        stopTimeSec
      })
    }
  }
}
