import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'

type PreviewPlayPayload = {
  filePath?: string
  startPercent?: number
}

type PreviewStopPayload = {
  reason?: string
}

type PreviewStopReason = 'explicit' | 'auto-finish' | 'manual-play' | 'switch' | 'cancel' | 'error'

type PauseMainPayload = {
  onPaused?: (wasPlaying: boolean) => void
}

const AUDIO_FOLLOW_SYSTEM_ID = ''

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

const normalizeStopReason = (reason?: string): PreviewStopReason => {
  switch (reason) {
    case 'explicit':
    case 'auto-finish':
    case 'manual-play':
    case 'switch':
    case 'error':
      return reason
    default:
      return 'cancel'
  }
}

const toPreviewUrl = (filePath: string) => {
  const raw = (filePath || '').trim()
  if (!raw) return ''
  if (raw.startsWith('frkb-preview://')) return raw
  return `frkb-preview://local/?path=${encodeURIComponent(raw)}`
}

export function useWaveformPreviewPlayer() {
  const runtime = useRuntimeStore()
  const previewActive = ref(false)
  const previewFilePath = ref('')
  const resumeMainPlayer = ref(false)
  const pendingStartPercent = ref(0)
  const playToken = ref(0)
  const audioElement = ref<HTMLAudioElement | null>(null)
  const activeSrc = ref('')
  let pendingOutputDeviceId = runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
  let progressRaf: number | null = null
  let stopping = false

  const emitPreviewState = (active: boolean, filePath: string | null) => {
    emitter.emit('waveform-preview:state', {
      filePath: filePath || '',
      active
    })
  }

  const emitPreviewProgress = (currentTime?: number) => {
    if (!previewActive.value) return
    const audio = audioElement.value
    if (!audio) return
    const filePath = previewFilePath.value
    if (!filePath) return
    const duration = audio.duration
    if (!duration || !Number.isFinite(duration)) return
    const timeValue =
      typeof currentTime === 'number' && Number.isFinite(currentTime)
        ? currentTime
        : audio.currentTime
    const percent = duration > 0 ? clamp01(timeValue / duration) : 0
    emitter.emit('waveform-preview:progress', {
      filePath,
      percent
    })
  }

  const stopProgressLoop = () => {
    if (progressRaf !== null) {
      cancelAnimationFrame(progressRaf)
      progressRaf = null
    }
  }

  const startProgressLoop = () => {
    stopProgressLoop()
    const loop = () => {
      const audio = audioElement.value
      if (!audio || audio.paused || audio.ended) {
        progressRaf = null
        return
      }
      emitPreviewProgress()
      progressRaf = requestAnimationFrame(loop)
    }
    progressRaf = requestAnimationFrame(loop)
  }

  const applySavedVolume = () => {
    const audio = audioElement.value
    if (!audio) return
    try {
      const s = localStorage.getItem('frkb_volume')
      let v = s !== null ? parseFloat(s) : NaN
      if (!(v >= 0 && v <= 1)) v = 0.8
      audio.volume = v
    } catch {}
  }

  const applyAudioOutputDevice = async (deviceId: string) => {
    pendingOutputDeviceId = deviceId || AUDIO_FOLLOW_SYSTEM_ID
    const audio = audioElement.value
    if (!audio) {
      return
    }
    const setSinkId = (audio as any)?.setSinkId
    if (typeof setSinkId !== 'function') {
      return
    }
    try {
      await setSinkId.call(audio, pendingOutputDeviceId)
    } catch (error) {
      console.warn('[waveform-preview] Failed to switch output device, fallback to default', error)
      if (pendingOutputDeviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
        pendingOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
        try {
          await setSinkId.call(audio, AUDIO_FOLLOW_SYSTEM_ID)
        } catch {}
      }
    }
  }

  const pauseMainPlayerIfNeeded = () => {
    resumeMainPlayer.value = false
    emitter.emit('waveform-preview:pause-main', {
      onPaused: (wasPlaying: boolean) => {
        resumeMainPlayer.value = wasPlaying
      }
    } satisfies PauseMainPayload)
  }

  const stopWaveformPreview = (reason: PreviewStopReason) => {
    if (!previewActive.value || stopping) return
    stopping = true
    const filePath = previewFilePath.value
    previewActive.value = false
    previewFilePath.value = ''
    pendingStartPercent.value = 0
    playToken.value += 1
    emitPreviewState(false, filePath || null)
    stopProgressLoop()

    const audio = audioElement.value
    if (audio) {
      audio.pause()
      try {
        audio.currentTime = 0
      } catch {}
      audio.muted = false
    }

    const shouldResume =
      resumeMainPlayer.value && (reason === 'explicit' || reason === 'auto-finish')
    resumeMainPlayer.value = false
    if (shouldResume) {
      emitter.emit('waveform-preview:resume-main')
    }
    stopping = false
  }

  const ensureAudioElement = () => {
    if (!audioElement.value) {
      const audio = document.createElement('audio')
      audio.preload = 'auto'
      audio.addEventListener('play', () => {
        emitPreviewProgress()
        startProgressLoop()
      })
      audio.addEventListener('pause', () => {
        emitPreviewProgress()
        stopProgressLoop()
      })
      audio.addEventListener('timeupdate', () => emitPreviewProgress())
      audio.addEventListener('ended', () => stopWaveformPreview('auto-finish'))
      audio.addEventListener('error', () => stopWaveformPreview('error'))
      audioElement.value = audio
      if (!audio.parentNode && typeof document !== 'undefined') {
        audio.style.display = 'none'
        document.body.appendChild(audio)
      }
      applySavedVolume()
      void applyAudioOutputDevice(pendingOutputDeviceId)
    }
    return audioElement.value
  }

  const playFromPercent = (audio: HTMLAudioElement, token: number, startPercent: number) => {
    if (playToken.value !== token) return
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0
    const startTime = duration > 0 ? duration * clamp01(startPercent) : 0
    try {
      if (typeof (audio as any).fastSeek === 'function') {
        ;(audio as any).fastSeek(startTime)
      } else {
        audio.currentTime = startTime
      }
    } catch {}
    if (audio.paused) {
      const playPromise = audio.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          if (playToken.value === token) {
            stopWaveformPreview('error')
          }
        })
      }
    }
    emitPreviewProgress(startTime)
  }

  const startWaveformPreview = (payload: PreviewPlayPayload) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    const startPercent = clamp01(payload?.startPercent ?? 0)
    if (!previewActive.value) {
      pauseMainPlayerIfNeeded()
    }
    previewActive.value = true
    previewFilePath.value = filePath
    pendingStartPercent.value = startPercent
    emitPreviewState(true, filePath)

    const audio = ensureAudioElement()
    if (!audio) return
    applySavedVolume()

    const token = playToken.value + 1
    playToken.value = token
    const nextSrc = toPreviewUrl(filePath)
    if (!nextSrc) {
      stopWaveformPreview('error')
      return
    }

    if (activeSrc.value !== nextSrc) {
      audio.pause()
      audio.src = nextSrc
      audio.load()
      activeSrc.value = nextSrc
    } else {
      audio.pause()
    }

    const needsSeek = startPercent > 0.0001
    audio.muted = needsSeek ? true : false

    const playPromise = audio.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        if (playToken.value === token) {
          stopWaveformPreview('error')
        }
      })
    }

    if (!needsSeek) {
      emitPreviewProgress(0)
      return
    }

    const applySeek = () => {
      if (playToken.value !== token) return
      playFromPercent(audio, token, startPercent)
      audio.muted = false
    }

    if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) {
      applySeek()
      return
    }

    audio.addEventListener('loadedmetadata', applySeek, { once: true })
  }

  const handlePreviewPlay = (payload: PreviewPlayPayload) => {
    startWaveformPreview(payload)
  }

  const handlePreviewStop = (payload?: PreviewStopPayload) => {
    const reason = normalizeStopReason(payload?.reason)
    stopWaveformPreview(reason)
  }

  onMounted(() => {
    emitter.on('waveform-preview:play', handlePreviewPlay)
    emitter.on('waveform-preview:stop', handlePreviewStop)
  })

  watch(
    () => runtime.setting.audioOutputDeviceId,
    (newValue) => {
      const nextId = newValue || AUDIO_FOLLOW_SYSTEM_ID
      pendingOutputDeviceId = nextId
      void applyAudioOutputDevice(nextId)
    },
    { immediate: true }
  )

  watch(
    () => runtime.songsArea.songListUUID,
    (nextValue, prevValue) => {
      if (nextValue === prevValue) return
      if (!previewActive.value) return
      stopWaveformPreview('switch')
    }
  )

  onUnmounted(() => {
    emitter.off('waveform-preview:play', handlePreviewPlay)
    emitter.off('waveform-preview:stop', handlePreviewStop)
    stopWaveformPreview('cancel')
    stopProgressLoop()
    if (audioElement.value) {
      audioElement.value.pause()
      audioElement.value.src = ''
      audioElement.value.load()
      if (audioElement.value.parentNode) {
        audioElement.value.parentNode.removeChild(audioElement.value)
      }
      audioElement.value = null
    }
  })
}
