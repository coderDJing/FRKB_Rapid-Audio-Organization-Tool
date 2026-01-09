import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { WebAudioPlayer } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

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

export function useWaveformPreviewPlayer() {
  const runtime = useRuntimeStore()
  const audioContextRef = shallowRef<AudioContext | null>(null)
  const previewPlayer = shallowRef<WebAudioPlayer | null>(null)
  const previewActive = ref(false)
  const previewFilePath = ref('')
  const previewRequestId = ref(0)
  const resumeMainPlayer = ref(false)
  const pendingStartPercent = ref(0)
  const loadedFilePath = ref<string | null>(null)
  let pendingOutputDeviceId = runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
  let stopping = false

  const emitPreviewState = (active: boolean, filePath: string | null) => {
    emitter.emit('waveform-preview:state', {
      filePath: filePath || '',
      active
    })
  }

  const emitPreviewProgress = (currentTime?: number) => {
    if (!previewActive.value) return
    const player = previewPlayer.value
    if (!player) return
    const filePath = previewFilePath.value
    if (!filePath) return
    const duration = player.getDuration()
    if (!duration || !Number.isFinite(duration)) return
    const timeValue =
      typeof currentTime === 'number' && Number.isFinite(currentTime)
        ? currentTime
        : player.getCurrentTime()
    const percent = duration > 0 ? clamp01(timeValue / duration) : 0
    emitter.emit('waveform-preview:progress', {
      filePath,
      percent
    })
  }

  const applySavedVolume = () => {
    try {
      const s = localStorage.getItem('frkb_volume')
      let v = s !== null ? parseFloat(s) : NaN
      if (!(v >= 0 && v <= 1)) v = 0.8
      previewPlayer.value?.setVolume(v)
    } catch {}
  }

  const applyAudioOutputDevice = async (deviceId: string) => {
    pendingOutputDeviceId = deviceId || AUDIO_FOLLOW_SYSTEM_ID
    const playerInstance = previewPlayer.value
    if (!playerInstance) {
      return
    }
    try {
      await playerInstance.setOutputDevice(pendingOutputDeviceId)
    } catch (error) {
      console.warn('[waveform-preview] Failed to switch output device, fallback to default', error)
      if (pendingOutputDeviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
        pendingOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
        try {
          await playerInstance.setOutputDevice(AUDIO_FOLLOW_SYSTEM_ID)
        } catch (_) {
          // 回退默认输出失败时无需额外处理
        }
      }
    }
  }

  const bindPlayerEvents = (player: WebAudioPlayer) => {
    player.on('play', () => emitPreviewProgress())
    player.on('pause', () => emitPreviewProgress())
    player.on('timeupdate', (time) => emitPreviewProgress(time))
    player.on('seeked', ({ time }) => emitPreviewProgress(time))
    player.on('finish', () => stopWaveformPreview('auto-finish'))
    player.on('error', () => stopWaveformPreview('error'))
  }

  const ensurePreviewPlayer = () => {
    if (!audioContextRef.value) {
      audioContextRef.value = new AudioContext()
    }
    if (!previewPlayer.value) {
      const player = new WebAudioPlayer(audioContextRef.value as AudioContext)
      previewPlayer.value = player
      bindPlayerEvents(player)
      applySavedVolume()
      void applyAudioOutputDevice(pendingOutputDeviceId)
    }
    return previewPlayer.value
  }

  const pauseMainPlayerIfNeeded = () => {
    resumeMainPlayer.value = false
    emitter.emit('waveform-preview:pause-main', {
      onPaused: (wasPlaying: boolean) => {
        resumeMainPlayer.value = wasPlaying
      }
    } satisfies PauseMainPayload)
  }

  const playPreviewAtPercent = (startPercent: number) => {
    const player = previewPlayer.value
    if (!player) return
    const duration = player.getDuration()
    const startTime = duration > 0 ? duration * clamp01(startPercent) : 0
    player.play(startTime)
    emitPreviewProgress(startTime)
  }

  const stopWaveformPreview = (reason: PreviewStopReason) => {
    if (!previewActive.value || stopping) return
    stopping = true
    const filePath = previewFilePath.value
    previewActive.value = false
    previewFilePath.value = ''
    pendingStartPercent.value = 0
    previewRequestId.value += 1
    emitPreviewState(false, filePath || null)
    if (previewPlayer.value) {
      previewPlayer.value.stop()
      previewPlayer.value.empty()
    }
    loadedFilePath.value = null
    const shouldResume =
      resumeMainPlayer.value && (reason === 'explicit' || reason === 'auto-finish')
    resumeMainPlayer.value = false
    if (shouldResume) {
      emitter.emit('waveform-preview:resume-main')
    }
    stopping = false
  }

  const startWaveformPreview = async (payload: PreviewPlayPayload) => {
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

    const player = ensurePreviewPlayer()
    if (!player) return

    try {
      if (audioContextRef.value?.state === 'suspended') {
        await audioContextRef.value.resume()
      }
    } catch {}

    if (loadedFilePath.value === filePath && player.getDuration() > 0) {
      player.stop()
      playPreviewAtPercent(startPercent)
      return
    }

    player.stop()
    const nextRequestId = previewRequestId.value + 1
    previewRequestId.value = nextRequestId
    window.electron.ipcRenderer.send('readPreviewSongFile', filePath, nextRequestId)
  }

  const handlePreviewPlay = (payload: PreviewPlayPayload) => {
    void startWaveformPreview(payload)
  }

  const handlePreviewStop = (payload?: PreviewStopPayload) => {
    const reason = normalizeStopReason(payload?.reason)
    stopWaveformPreview(reason)
  }

  const handleReadPreviewSongFile = (
    _event: any,
    payload: {
      pcmData: Float32Array
      sampleRate: number
      channels: number
      totalFrames: number
    },
    filePath: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== previewRequestId.value) return
    if (!previewActive.value) return
    if (filePath !== previewFilePath.value) return
    const player = ensurePreviewPlayer()
    if (!player) return
    try {
      player.loadPCM(payload.pcmData, payload.sampleRate, payload.channels, {
        filePath
      })
      loadedFilePath.value = filePath
      playPreviewAtPercent(pendingStartPercent.value)
    } catch {
      stopWaveformPreview('error')
    }
  }

  const handleReadPreviewSongFileError = (
    _event: any,
    filePath: string,
    _errorMessage: string,
    requestId?: number
  ) => {
    if (requestId && requestId !== previewRequestId.value) return
    if (filePath !== previewFilePath.value) return
    stopWaveformPreview('error')
  }

  onMounted(() => {
    emitter.on('waveform-preview:play', handlePreviewPlay)
    emitter.on('waveform-preview:stop', handlePreviewStop)
    if (window?.electron?.ipcRenderer) {
      window.electron.ipcRenderer.on('readedPreviewSongFile', handleReadPreviewSongFile)
      window.electron.ipcRenderer.on('readPreviewSongFileError', handleReadPreviewSongFileError)
    }
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
    if (window?.electron?.ipcRenderer) {
      window.electron.ipcRenderer.removeListener('readedPreviewSongFile', handleReadPreviewSongFile)
      window.electron.ipcRenderer.removeListener(
        'readPreviewSongFileError',
        handleReadPreviewSongFileError
      )
    }
    stopWaveformPreview('cancel')
    if (previewPlayer.value) {
      previewPlayer.value.destroy()
      previewPlayer.value = null
    }
    if (audioContextRef.value) {
      void audioContextRef.value.close().catch(() => {})
      audioContextRef.value = null
    }
  })
}
