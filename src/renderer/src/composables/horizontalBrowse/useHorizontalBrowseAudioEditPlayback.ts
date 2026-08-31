import { onUnmounted, ref, watch, type Ref } from 'vue'
import {
  ensureTransportSequencerWorkletModule,
  createTransportSequencedBufferSource,
  type TransportPlayableSource
} from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import type { TransportPlaybackSequence } from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'
import { buildAudioEditPlaybackSequence, type AudioEditClip } from '@shared/audioEditTimeline'

type UseHorizontalBrowseAudioEditPlaybackParams = {
  filePath: Ref<string>
  clips: Ref<AudioEditClip[]>
  enabled: Ref<boolean>
}

const fillAudioBufferFromInterleavedPcm = (
  buffer: AudioBuffer,
  pcmData: Float32Array,
  channels: number,
  frameCount: number
) => {
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex)
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      channel[frameIndex] = pcmData[frameIndex * channels + channelIndex] || 0
    }
  }
}

const toFloat32Array = (value: unknown): Float32Array => {
  if (value instanceof Float32Array) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  return new Float32Array()
}

const buildSequence = (clips: AudioEditClip[]): TransportPlaybackSequence => {
  const built = buildAudioEditPlaybackSequence(clips)
  return {
    totalPlanSec: built.totalPlanSec,
    segments: built.segments.map((segment, index) => ({
      key: `audio-edit-${index}`,
      localStartSec: segment.planStartSec,
      localEndSec: segment.planEndSec,
      baseLocalStartSec: segment.planStartSec,
      baseLocalEndSec: segment.planEndSec,
      sourceStartSec: segment.sourceStartSec,
      sourceEndSec: segment.sourceEndSec,
      planStartSec: segment.planStartSec,
      planEndSec: segment.planEndSec
    }))
  }
}

export const useHorizontalBrowseAudioEditPlayback = (
  params: UseHorizontalBrowseAudioEditPlaybackParams
) => {
  const ready = ref(false)
  const preparing = ref(false)
  const prepareError = ref('')
  const playing = ref(false)
  const playheadSec = ref(0)
  const sourceBuffer = ref<AudioBuffer | null>(null)
  let audioCtx: AudioContext | null = null
  let playable: TransportPlayableSource | null = null
  let positionTimer: number | null = null
  let prepareToken = 0

  const ensureContext = (sampleRate?: number) => {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx
    audioCtx = new AudioContext(sampleRate ? { sampleRate } : undefined)
    return audioCtx
  }

  const stopPositionTimer = () => {
    if (positionTimer === null) return
    window.clearInterval(positionTimer)
    positionTimer = null
  }

  const stopPlayback = async (keepPlayhead = true) => {
    stopPositionTimer()
    const current = playable
    playable = null
    playing.value = false
    if (!keepPlayhead) playheadSec.value = 0
    if (!current) return
    try {
      current.onended = null
      current.stop()
    } catch {
      /* 已停止 */
    }
    try {
      current.disconnect()
    } catch {
      /* 已断开 */
    }
  }

  const startPositionTimer = () => {
    stopPositionTimer()
    positionTimer = window.setInterval(() => {
      const sec = playable?.resolvePlaybackPositionSec()
      if (typeof sec === 'number' && Number.isFinite(sec)) playheadSec.value = Math.max(0, sec)
    }, 30)
  }

  const decodeFile = async (filePath: string) => {
    const result = await window.electron.ipcRenderer.invoke(
      'mixtape:decode-for-transport',
      filePath
    )
    const pcmData = toFloat32Array(result?.pcmData)
    const sampleRate = Number(result?.sampleRate) || 44100
    const channels = Math.max(1, Number(result?.channels) || 1)
    const totalFrames = Number(result?.totalFrames) || 0
    const frameCount =
      totalFrames > 0
        ? Math.min(totalFrames, Math.floor(pcmData.length / channels))
        : Math.floor(pcmData.length / channels)
    if (frameCount <= 0) throw new Error('empty')
    const ctx = ensureContext(sampleRate)
    const buffer = ctx.createBuffer(channels, frameCount, sampleRate)
    fillAudioBufferFromInterleavedPcm(buffer, pcmData, channels, frameCount)
    return buffer
  }

  const prepare = async (filePath: string) => {
    const token = (prepareToken += 1)
    ready.value = false
    prepareError.value = ''
    sourceBuffer.value = null
    if (!filePath) {
      preparing.value = false
      return
    }
    preparing.value = true
    try {
      const buffer = await decodeFile(filePath)
      if (token !== prepareToken) return
      sourceBuffer.value = buffer
      await ensureTransportSequencerWorkletModule(ensureContext(buffer.sampleRate))
      if (token !== prepareToken) return
      ready.value = true
    } catch {
      if (token !== prepareToken) return
      prepareError.value = 'prepare-failed'
      ready.value = false
    } finally {
      if (token === prepareToken) preparing.value = false
    }
  }

  const play = async () => {
    const buffer = sourceBuffer.value
    const ctx = audioCtx
    if (!buffer || !ctx || !params.enabled.value) return false
    await stopPlayback(true)
    if (ctx.state === 'suspended') await ctx.resume()
    const sequence = buildSequence(params.clips.value)
    if (sequence.totalPlanSec <= 0) return false
    const requestedStartSec = Math.max(0, Number(playheadSec.value) || 0)
    const startSec =
      requestedStartSec >= sequence.totalPlanSec - 0.0001
        ? 0
        : Math.min(sequence.totalPlanSec, requestedStartSec)
    playheadSec.value = startSec
    const source = createTransportSequencedBufferSource(ctx, buffer, sequence)
    source.connect(ctx.destination)
    source.onended = () => {
      playheadSec.value = sequence.totalPlanSec
      playing.value = false
      stopPositionTimer()
    }
    playable = source
    playing.value = true
    startPositionTimer()
    source.start(undefined, startSec)
    return true
  }

  const reloadSource = async () => {
    await stopPlayback(true)
    if (!params.enabled.value) return
    await prepare(params.filePath.value)
  }

  const pause = async () => {
    const sec = playable?.resolvePlaybackPositionSec()
    if (typeof sec === 'number' && Number.isFinite(sec)) playheadSec.value = Math.max(0, sec)
    await stopPlayback(true)
  }

  const seek = async (seconds: number) => {
    playheadSec.value = Math.max(0, Number(seconds) || 0)
    if (!playing.value) return
    await play()
  }

  const toggle = async () => {
    if (playing.value) {
      await pause()
      return
    }
    await play()
  }

  watch(
    () => params.filePath.value,
    (filePath) => {
      void stopPlayback(false)
      if (params.enabled.value) void prepare(filePath)
    }
  )

  watch(
    () => params.enabled.value,
    (enabled) => {
      if (!enabled) {
        void stopPlayback(true)
        return
      }
      void prepare(params.filePath.value)
    },
    { immediate: true }
  )

  watch(
    () => params.clips.value,
    async () => {
      if (!playing.value) return
      await play()
    },
    { deep: true }
  )

  onUnmounted(() => {
    prepareToken += 1
    void stopPlayback(false)
    if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close()
    audioCtx = null
  })

  return {
    ready,
    preparing,
    prepareError,
    playing,
    playheadSec,
    sourceBuffer,
    play,
    pause,
    seek,
    toggle,
    stopPlayback,
    reloadSource
  }
}
