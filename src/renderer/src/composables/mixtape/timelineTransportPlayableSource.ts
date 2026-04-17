import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import soundTouchProcessorUrl from '@soundtouchjs/audio-worklet/processor?url'
import type { TransportPlaybackSequence } from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'

export type TransportPlaybackRateControl = {
  value: number
  setTargetAtTime: (value: number, startTime: number, timeConstant: number) => void
}

export type TransportPlayableSource = {
  buffer: AudioBuffer | null
  startOffsetKind: 'source' | 'plan'
  resolveLatencySec: () => number
  resolvePlaybackPositionSec: () => number | null
  playbackRate: TransportPlaybackRateControl
  onended: (() => void) | null
  connect: (destination: AudioNode) => void
  disconnect: () => void
  start: (when?: number, offset?: number) => void
  stop: (when?: number) => void
}

const WORKLET_NAME = 'mixtape-transport-keylock'
const SEQUENCER_WORKLET_NAME = 'mixtape-transport-sequencer'

export type TransportPlayableAudioContext = BaseAudioContext & {
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
const soundTouchModuleByContext = new WeakMap<TransportPlayableAudioContext, Promise<void>>()
const sequencerModuleByContext = new WeakMap<TransportPlayableAudioContext, Promise<void>>()
const STREAMING_CHUNK_FRAMES = 44100 * 6
const STREAMING_LOOKAHEAD_CHUNKS = 3
const STREAMING_KEEP_BEHIND_FRAMES = 44100 * 2
const SOUNDTOUCH_OVERLAP_MS = 8
const SOUNDTOUCH_AUTOSEQ_TEMPO_LOW = 0.25
const SOUNDTOUCH_AUTOSEQ_TEMPO_TOP = 4
const SOUNDTOUCH_AUTOSEQ_AT_MIN = 125
const SOUNDTOUCH_AUTOSEQ_AT_MAX = 50
const SOUNDTOUCH_AUTOSEQ_K =
  (SOUNDTOUCH_AUTOSEQ_AT_MAX - SOUNDTOUCH_AUTOSEQ_AT_MIN) /
  (SOUNDTOUCH_AUTOSEQ_TEMPO_TOP - SOUNDTOUCH_AUTOSEQ_TEMPO_LOW)
const SOUNDTOUCH_AUTOSEQ_C =
  SOUNDTOUCH_AUTOSEQ_AT_MIN - SOUNDTOUCH_AUTOSEQ_K * SOUNDTOUCH_AUTOSEQ_TEMPO_LOW
const SOUNDTOUCH_AUTOSEEK_AT_MIN = 25
const SOUNDTOUCH_AUTOSEEK_AT_MAX = 15
const SOUNDTOUCH_AUTOSEEK_K =
  (SOUNDTOUCH_AUTOSEEK_AT_MAX - SOUNDTOUCH_AUTOSEEK_AT_MIN) /
  (SOUNDTOUCH_AUTOSEQ_TEMPO_TOP - SOUNDTOUCH_AUTOSEQ_TEMPO_LOW)
const SOUNDTOUCH_AUTOSEEK_C =
  SOUNDTOUCH_AUTOSEEK_AT_MIN - SOUNDTOUCH_AUTOSEEK_K * SOUNDTOUCH_AUTOSEQ_TEMPO_LOW

const cloneBufferChannels = (buffer: AudioBuffer) => {
  const channels: Float32Array[] = []
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
    const sourceIndex = Math.min(buffer.numberOfChannels - 1, channelIndex)
    channels.push(new Float32Array(buffer.getChannelData(Math.max(0, sourceIndex))))
  }
  return channels
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveSoundTouchAutoWindowMs = (tempo: number, kind: 'sequence' | 'seek') => {
  const safeTempo = clampNumber(
    Number(tempo) || 1,
    SOUNDTOUCH_AUTOSEQ_TEMPO_LOW,
    SOUNDTOUCH_AUTOSEQ_TEMPO_TOP
  )
  if (kind === 'sequence') {
    return Math.floor(
      clampNumber(
        SOUNDTOUCH_AUTOSEQ_C + SOUNDTOUCH_AUTOSEQ_K * safeTempo,
        SOUNDTOUCH_AUTOSEQ_AT_MAX,
        SOUNDTOUCH_AUTOSEQ_AT_MIN
      ) + 0.5
    )
  }
  return Math.floor(
    clampNumber(
      SOUNDTOUCH_AUTOSEEK_C + SOUNDTOUCH_AUTOSEEK_K * safeTempo,
      SOUNDTOUCH_AUTOSEEK_AT_MAX,
      SOUNDTOUCH_AUTOSEEK_AT_MIN
    ) + 0.5
  )
}

export const estimateTransportSoundTouchLatencySec = (sampleRate: number, playbackRate: number) => {
  const safeSampleRate = Math.max(1, Number(sampleRate) || 44100)
  const safeTempo = clampNumber(Number(playbackRate) || 1, 0.25, 4)
  let overlapFrames = (safeSampleRate * SOUNDTOUCH_OVERLAP_MS) / 1000
  overlapFrames = overlapFrames < 16 ? 16 : overlapFrames
  overlapFrames -= overlapFrames % 8
  const seekWindowFrames = Math.floor(
    (safeSampleRate * resolveSoundTouchAutoWindowMs(safeTempo, 'sequence')) / 1000
  )
  const seekFrames = Math.floor(
    (safeSampleRate * resolveSoundTouchAutoWindowMs(safeTempo, 'seek')) / 1000
  )
  const nominalSkip = safeTempo * (seekWindowFrames - overlapFrames)
  const intSkip = Math.floor(nominalSkip + 0.5)
  const sampleReq = Math.max(intSkip + overlapFrames, seekWindowFrames) + seekFrames
  const outputChunkFrames = overlapFrames + Math.max(0, seekWindowFrames - 2 * overlapFrames)
  const latencyFrames = Math.max(0, sampleReq - outputChunkFrames)
  return latencyFrames / safeSampleRate
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
  const moduleUrl = new URL('../../workers/mixtapeTransportKeyLock.worklet.js', import.meta.url)
  const task = audioCtx.audioWorklet.addModule(moduleUrl.href)
  workletModuleByContext.set(audioCtx, task)
  await task
}

export const ensureTransportSoundTouchWorkletModule = async (
  audioCtx: TransportPlayableAudioContext
) => {
  if (!audioCtx.audioWorklet) {
    throw new Error('AudioWorklet is unavailable')
  }
  const existing = soundTouchModuleByContext.get(audioCtx)
  if (existing) {
    await existing
    return
  }
  const task = SoundTouchNode.register(audioCtx, soundTouchProcessorUrl)
  soundTouchModuleByContext.set(audioCtx, task)
  await task
}

export const ensureTransportSequencerWorkletModule = async (
  audioCtx: TransportPlayableAudioContext
) => {
  if (!audioCtx.audioWorklet) {
    throw new Error('AudioWorklet is unavailable')
  }
  const existing = sequencerModuleByContext.get(audioCtx)
  if (existing) {
    await existing
    return
  }
  const moduleUrl = new URL('../../workers/mixtapeTransportSequencer.worklet.js', import.meta.url)
  const task = audioCtx.audioWorklet.addModule(moduleUrl.href)
  sequencerModuleByContext.set(audioCtx, task)
  await task
}

const postPlaybackSequenceToWorklet = (
  node: AudioWorkletNode,
  buffer: AudioBuffer,
  sequence: TransportPlaybackSequence
) => {
  const segments = Array.isArray(sequence?.segments)
    ? sequence.segments
        .map((segment) => {
          const sourceStartFrame = Math.max(
            0,
            Math.floor((Number(segment.sourceStartSec) || 0) * buffer.sampleRate)
          )
          const sourceEndFrame = Math.max(
            sourceStartFrame,
            Math.ceil((Number(segment.sourceEndSec) || 0) * buffer.sampleRate)
          )
          return {
            sourceStartFrame,
            frameCount: Math.max(0, sourceEndFrame - sourceStartFrame)
          }
        })
        .filter((segment) => segment.frameCount > 0)
    : []
  node.port.postMessage({
    type: 'set-sequence',
    segments
  })
}

export const createTransportBufferSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer
): TransportPlayableSource => {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  const playableSource = source as unknown as TransportPlayableSource
  playableSource.startOffsetKind = 'source'
  playableSource.resolveLatencySec = () => 0
  playableSource.resolvePlaybackPositionSec = () => null
  return playableSource
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
  let latestPositionSec: number | null = null
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
    if (!data) return
    if (data.type === 'position') {
      latestPositionSec = Math.max(0, Number(data.frame) || 0) / buffer.sampleRate
      return
    }
    if (data.type !== 'ended') return
    endedHandler?.()
  }

  return {
    buffer,
    startOffsetKind: 'source',
    resolveLatencySec: () => 0,
    resolvePlaybackPositionSec: () => latestPositionSec,
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
        node.port.postMessage({ type: 'dispose' })
      } catch {}
      try {
        node.port.onmessage = null
      } catch {}
      try {
        node.port.close()
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
      latestPositionSec = safeOffset
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

export const createTransportSequencedKeyLockSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer,
  sequence: TransportPlaybackSequence
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
  postPlaybackSequenceToWorklet(node, buffer, sequence)

  let endedHandler: (() => void) | null = null
  let latestPositionSec: number | null = null
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
    if (!data) return
    if (data.type === 'position') {
      latestPositionSec = Math.max(0, Number(data.frame) || 0) / buffer.sampleRate
      return
    }
    if (data.type !== 'ended') return
    endedHandler?.()
  }

  return {
    buffer,
    startOffsetKind: 'plan',
    resolveLatencySec: () => 0,
    resolvePlaybackPositionSec: () => latestPositionSec,
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
        node.port.postMessage({ type: 'dispose' })
      } catch {}
      try {
        node.port.onmessage = null
      } catch {}
      try {
        node.port.close()
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
      latestPositionSec = safeOffset
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

export const createTransportSequencedSoundTouchSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer,
  sequence: TransportPlaybackSequence
): TransportPlayableSource => {
  const upstream = createTransportSequencedBufferSource(audioCtx, buffer, sequence)
  const node = new SoundTouchNode(audioCtx)
  node.pitch.value = 1
  node.pitchSemitones.value = 0
  node.tempo.value = 1
  node.rate.value = 1
  node.playbackRate.value = 1
  upstream.connect(node)

  let endedHandler: (() => void) | null = null
  upstream.onended = () => {
    endedHandler?.()
  }

  const playbackRate: TransportPlaybackRateControl = {
    value: 1,
    setTargetAtTime(value: number, startTime: number, timeConstant: number) {
      const nextValue = Number(value) || 1
      const nextStartTime = Number(startTime) || audioCtx.currentTime
      const nextTimeConstant = Number(timeConstant) || 0.04
      playbackRate.value = nextValue
      try {
        upstream.playbackRate.setTargetAtTime(nextValue, nextStartTime, nextTimeConstant)
      } catch {}
      try {
        node.playbackRate.setTargetAtTime(nextValue, nextStartTime, nextTimeConstant)
      } catch {}
    }
  }

  return {
    buffer,
    startOffsetKind: 'plan',
    resolveLatencySec: () =>
      estimateTransportSoundTouchLatencySec(buffer.sampleRate, playbackRate.value),
    resolvePlaybackPositionSec: () => upstream.resolvePlaybackPositionSec(),
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
        upstream.onended = null
      } catch {}
      try {
        upstream.disconnect()
      } catch {}
      try {
        node.disconnect()
      } catch {}
    },
    start(when?: number, offset?: number) {
      upstream.start(when, offset)
    },
    stop(when?: number) {
      upstream.stop(when)
    }
  }
}

export const createTransportStreamingKeyLockSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer
): TransportPlayableSource => {
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  const node = new AudioWorkletNode(audioCtx, WORKLET_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [outputChannels]
  })
  node.port.postMessage({
    type: 'set-source-meta',
    sampleRate: buffer.sampleRate,
    frameCount: buffer.length,
    outputChannels
  })

  let endedHandler: (() => void) | null = null
  let nextChunkStartFrame = 0
  let loadedUntilFrame = 0
  let trimmedBeforeFrame = 0
  let latestPositionSec: number | null = null

  const enqueueChunk = (startFrame: number) => {
    const safeStartFrame = Math.max(0, Math.floor(startFrame))
    if (safeStartFrame >= buffer.length) return
    const endFrame = Math.min(buffer.length, safeStartFrame + STREAMING_CHUNK_FRAMES)
    if (endFrame <= safeStartFrame) return
    const channels: Float32Array[] = []
    for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
      const sourceIndex = Math.min(buffer.numberOfChannels - 1, channelIndex)
      const source = buffer.getChannelData(Math.max(0, sourceIndex))
      channels.push(source.slice(safeStartFrame, endFrame))
    }
    node.port.postMessage(
      {
        type: 'append-chunk',
        startFrame: safeStartFrame,
        frameCount: endFrame - safeStartFrame,
        channels
      },
      channels.map((channel) => channel.buffer)
    )
    nextChunkStartFrame = endFrame
    loadedUntilFrame = Math.max(loadedUntilFrame, endFrame)
  }

  const ensureLookaheadChunks = (frame: number) => {
    const targetFrame =
      Math.max(0, Math.floor(frame)) + STREAMING_CHUNK_FRAMES * STREAMING_LOOKAHEAD_CHUNKS
    while (loadedUntilFrame < Math.min(buffer.length, targetFrame)) {
      enqueueChunk(nextChunkStartFrame)
    }
  }

  const trimChunks = (frame: number) => {
    const trimBefore = Math.max(0, Math.floor(frame) - STREAMING_KEEP_BEHIND_FRAMES)
    if (trimBefore <= trimmedBeforeFrame) return
    trimmedBeforeFrame = trimBefore
    node.port.postMessage({
      type: 'trim-before-frame',
      frame: trimBefore
    })
  }

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
    if (!data) return
    if (data.type === 'position') {
      const frame = Math.max(0, Math.floor(Number(data.frame) || 0))
      latestPositionSec = frame / buffer.sampleRate
      ensureLookaheadChunks(frame)
      trimChunks(frame)
      return
    }
    if (data.type === 'ended') {
      endedHandler?.()
    }
  }

  return {
    buffer,
    startOffsetKind: 'source',
    resolveLatencySec: () => 0,
    resolvePlaybackPositionSec: () => latestPositionSec,
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
        node.port.postMessage({ type: 'dispose' })
      } catch {}
      try {
        node.port.onmessage = null
      } catch {}
      try {
        node.port.close()
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
      const startFrame = Math.min(
        buffer.length > 0 ? buffer.length - 1 : 0,
        Math.max(0, Math.floor(safeOffset * buffer.sampleRate))
      )
      latestPositionSec = startFrame / buffer.sampleRate
      nextChunkStartFrame = Math.floor(startFrame / STREAMING_CHUNK_FRAMES) * STREAMING_CHUNK_FRAMES
      loadedUntilFrame = nextChunkStartFrame
      trimmedBeforeFrame = 0
      ensureLookaheadChunks(startFrame)
      node.port.postMessage({
        type: 'start',
        startTimeSec,
        startFrame,
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

export const createTransportSequencedBufferSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer,
  sequence: TransportPlaybackSequence
): TransportPlayableSource => {
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  const node = new AudioWorkletNode(audioCtx, SEQUENCER_WORKLET_NAME, {
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
  postPlaybackSequenceToWorklet(node, buffer, sequence)

  let endedHandler: (() => void) | null = null
  let latestPositionSec: number | null = null
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
    if (!data) return
    if (data.type === 'position') {
      latestPositionSec = Math.max(0, Number(data.frame) || 0) / buffer.sampleRate
      return
    }
    if (data.type !== 'ended') return
    endedHandler?.()
  }

  return {
    buffer,
    startOffsetKind: 'plan',
    resolveLatencySec: () => 0,
    resolvePlaybackPositionSec: () => latestPositionSec,
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
        node.port.postMessage({ type: 'dispose' })
      } catch {}
      try {
        node.port.onmessage = null
      } catch {}
      try {
        node.port.close()
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
      latestPositionSec = safeOffset
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

export const createTransportSoundTouchPreviewSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer
): TransportPlayableSource => {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer

  const node = new SoundTouchNode(audioCtx)
  node.pitch.value = 1
  node.pitchSemitones.value = 0
  node.tempo.value = 1
  node.rate.value = 1
  node.playbackRate.value = 1
  source.connect(node)

  let endedHandler: (() => void) | null = null
  source.onended = () => {
    endedHandler?.()
  }

  const playbackRate: TransportPlaybackRateControl = {
    value: 1,
    setTargetAtTime(value: number, startTime: number, timeConstant: number) {
      const nextValue = Number(value) || 1
      const nextStartTime = Number(startTime) || audioCtx.currentTime
      const nextTimeConstant = Number(timeConstant) || 0.04
      playbackRate.value = nextValue
      try {
        source.playbackRate.setTargetAtTime(nextValue, nextStartTime, nextTimeConstant)
      } catch {}
      try {
        node.playbackRate.setTargetAtTime(nextValue, nextStartTime, nextTimeConstant)
      } catch {}
    }
  }

  return {
    buffer,
    startOffsetKind: 'source',
    resolveLatencySec: () =>
      estimateTransportSoundTouchLatencySec(buffer.sampleRate, playbackRate.value),
    resolvePlaybackPositionSec: () => null,
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
        source.onended = null
      } catch {}
      try {
        source.disconnect()
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
      source.start(startTimeSec, safeOffset)
    },
    stop(when?: number) {
      const stopTimeSec =
        Number.isFinite(Number(when)) && Number(when) > audioCtx.currentTime
          ? Number(when)
          : audioCtx.currentTime
      source.stop(stopTimeSec)
    }
  }
}
