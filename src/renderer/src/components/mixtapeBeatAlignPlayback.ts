import { computed, ref, type Ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

type UseMixtapeBeatAlignPlaybackParams = {
  filePathRef: Ref<string>
  previewLoading: Ref<boolean>
  previewMixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  resolveVisibleDurationSec: () => number
  resolvePreviewDurationSec: () => number
  clampPreviewStart: (value: number) => number
  schedulePreviewDraw: () => void
}

type DecodeForTransportResult = {
  pcmData: unknown
  sampleRate: number
  channels: number
  totalFrames: number
}

type StopPlaybackOptions = {
  syncPosition?: boolean
  cancelPending?: boolean
}

const PREVIEW_PLAY_ANCHOR_RATIO = 1 / 3
const PREVIEW_PLAY_END_GUARD_SEC = 0.02

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

export const useMixtapeBeatAlignPlayback = (params: UseMixtapeBeatAlignPlaybackParams) => {
  const {
    filePathRef,
    previewLoading,
    previewMixxxData,
    previewStartSec,
    resolveVisibleDurationSec,
    resolvePreviewDurationSec,
    clampPreviewStart,
    schedulePreviewDraw
  } = params

  const previewPlaying = ref(false)
  const previewDecoding = ref(false)
  const previewAnchorStyle = computed(() => ({
    left: `${(PREVIEW_PLAY_ANCHOR_RATIO * 100).toFixed(4)}%`
  }))
  const canTogglePreviewPlayback = computed(() => {
    if (previewPlaying.value) return true
    const hasPath = filePathRef.value.length > 0
    const hasWaveform = previewMixxxData.value !== null
    return hasPath && hasWaveform && !previewLoading.value && !previewDecoding.value
  })

  let playbackVersion = 0
  let playbackRaf = 0
  let playbackStartedAt = 0
  let playbackStartSec = 0
  let playbackDurationSec = 0
  let audioCtx: AudioContext | null = null
  let sourceNode: AudioBufferSourceNode | null = null
  const audioBufferCache = new Map<string, AudioBuffer>()
  const audioBufferInflight = new Map<string, Promise<AudioBuffer>>()

  const ensureAudioContext = (sampleRate?: number): AudioContext => {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx
    audioCtx = new AudioContext(sampleRate ? { sampleRate } : undefined)
    return audioCtx
  }

  const syncPreviewWindowToAnchorSec = (anchorSec: number) => {
    const total = resolvePreviewDurationSec()
    const visible = resolveVisibleDurationSec()
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(visible) || visible <= 0) return
    const nextStart = clampPreviewStart(anchorSec - visible * PREVIEW_PLAY_ANCHOR_RATIO)
    if (Math.abs(nextStart - previewStartSec.value) <= 0.0001) return
    previewStartSec.value = nextStart
    schedulePreviewDraw()
  }

  const resolveCurrentPlaybackSec = () => {
    const elapsed = Math.max(0, (performance.now() - playbackStartedAt) / 1000)
    return clampNumber(playbackStartSec + elapsed, 0, Math.max(0, playbackDurationSec))
  }

  const stopActivePlayback = (syncPosition: boolean) => {
    if (syncPosition && previewPlaying.value) {
      syncPreviewWindowToAnchorSec(resolveCurrentPlaybackSec())
    }
    previewPlaying.value = false

    if (playbackRaf) {
      cancelAnimationFrame(playbackRaf)
      playbackRaf = 0
    }
    if (sourceNode) {
      const node = sourceNode
      sourceNode = null
      try {
        node.onended = null
      } catch {}
      try {
        node.stop()
      } catch {}
      try {
        node.disconnect()
      } catch {}
    }
  }

  const stopPreviewPlayback = (options: StopPlaybackOptions = {}) => {
    const syncPosition = options.syncPosition !== false
    if (options.cancelPending !== false) {
      playbackVersion += 1
    }
    stopActivePlayback(syncPosition)
  }

  const decodeAudioBuffer = async (filePath: string): Promise<AudioBuffer> => {
    const cached = audioBufferCache.get(filePath)
    if (cached) return cached
    const inflight = audioBufferInflight.get(filePath)
    if (inflight) return inflight

    const task = (async () => {
      if (!window?.electron?.ipcRenderer?.invoke) {
        throw new Error('ipcRenderer.invoke is unavailable')
      }

      const result = (await window.electron.ipcRenderer.invoke(
        'mixtape:decode-for-transport',
        filePath
      )) as DecodeForTransportResult
      const pcm = normalizePcmData(result?.pcmData)
      const sampleRate = Math.max(1, Number(result?.sampleRate) || 44100)
      const channels = Math.max(1, Number(result?.channels) || 1)
      const totalFrames = Math.max(0, Number(result?.totalFrames) || 0)
      const frameCount =
        totalFrames > 0
          ? Math.min(totalFrames, Math.floor(pcm.length / channels))
          : Math.floor(pcm.length / channels)
      if (frameCount <= 0 || pcm.length <= 0) {
        throw new Error('decoded pcm is empty')
      }

      const ctx = ensureAudioContext(sampleRate)
      const buffer = ctx.createBuffer(channels, frameCount, sampleRate)
      for (let ch = 0; ch < channels; ch += 1) {
        const channelData = buffer.getChannelData(ch)
        let readIndex = ch
        for (let i = 0; i < frameCount; i += 1) {
          channelData[i] = pcm[readIndex] || 0
          readIndex += channels
        }
      }
      audioBufferCache.set(filePath, buffer)
      return buffer
    })()

    audioBufferInflight.set(filePath, task)
    try {
      return await task
    } finally {
      if (audioBufferInflight.get(filePath) === task) {
        audioBufferInflight.delete(filePath)
      }
    }
  }

  const warmupPreviewPlayback = async (filePath?: string) => {
    const normalized = typeof filePath === 'string' ? filePath.trim() : ''
    const targetPath = normalized || filePathRef.value
    if (!targetPath) return
    try {
      await decodeAudioBuffer(targetPath)
    } catch (error) {
      console.warn('[mixtape-beat-align] warmup decode failed', targetPath, error)
    }
  }

  const startPreviewPlayback = async () => {
    if (previewPlaying.value || previewDecoding.value) return
    const filePath = filePathRef.value
    if (!filePath) return

    const token = ++playbackVersion
    previewDecoding.value = true
    let buffer: AudioBuffer
    try {
      buffer = await decodeAudioBuffer(filePath)
    } catch (error) {
      console.error('[mixtape-beat-align] decode failed', filePath, error)
      if (token === playbackVersion) {
        previewDecoding.value = false
      }
      return
    }
    if (token !== playbackVersion) return
    previewDecoding.value = false

    stopActivePlayback(false)

    const ctx = ensureAudioContext(buffer.sampleRate)
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {}
    }

    const visible = resolveVisibleDurationSec()
    const baseStart = clampPreviewStart(previewStartSec.value)
    const anchorSec = baseStart + Math.max(0, visible) * PREVIEW_PLAY_ANCHOR_RATIO
    const duration = Math.max(0, Number(buffer.duration) || resolvePreviewDurationSec())
    const safeStart = clampNumber(anchorSec, 0, Math.max(0, duration - PREVIEW_PLAY_END_GUARD_SEC))

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    sourceNode = source
    playbackDurationSec = duration
    playbackStartSec = safeStart
    playbackStartedAt = performance.now()
    previewPlaying.value = true

    source.onended = () => {
      if (source !== sourceNode) return
      stopPreviewPlayback({ syncPosition: true })
    }

    try {
      source.start(0, safeStart)
    } catch (error) {
      console.error('[mixtape-beat-align] start playback failed', filePath, error)
      stopPreviewPlayback({ syncPosition: false })
      return
    }

    const tick = () => {
      if (!previewPlaying.value || token !== playbackVersion) return
      const currentSec = resolveCurrentPlaybackSec()
      if (currentSec >= playbackDurationSec) {
        syncPreviewWindowToAnchorSec(playbackDurationSec)
        stopPreviewPlayback({ syncPosition: false, cancelPending: false })
        return
      }
      syncPreviewWindowToAnchorSec(currentSec)
      playbackRaf = requestAnimationFrame(tick)
    }
    playbackRaf = requestAnimationFrame(tick)
  }

  const handlePreviewPlaybackToggle = () => {
    if (previewPlaying.value) {
      stopPreviewPlayback({ syncPosition: true })
      return
    }
    void startPreviewPlayback()
  }

  const cleanupPreviewPlayback = () => {
    stopPreviewPlayback({ syncPosition: false })
    audioBufferCache.clear()
    audioBufferInflight.clear()
    if (audioCtx && audioCtx.state !== 'closed') {
      try {
        void audioCtx.close()
      } catch {}
    }
    audioCtx = null
  }

  return {
    previewPlaying,
    previewDecoding,
    previewAnchorStyle,
    canTogglePreviewPlayback,
    handlePreviewPlaybackToggle,
    warmupPreviewPlayback,
    stopPreviewPlayback,
    cleanupPreviewPlayback
  }
}
