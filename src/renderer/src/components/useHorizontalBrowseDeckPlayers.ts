import { onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec
} from '@renderer/components/horizontalBrowseDetailMath'
import {
  WebAudioPlayer,
  canPlayHtmlAudio,
  type MixxxWaveformData
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'

export type HorizontalBrowseDeckKey = 'top' | 'bottom'

const PLAYBACK_STATE_PUBLISH_INTERVAL_MS = 80

type DecodePayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
}

type CreateDeckControllerResult = {
  currentSeconds: Ref<number>
  durationSeconds: Ref<number>
  playing: Ref<boolean>
  ready: Ref<boolean>
  cuePointSeconds: Ref<number>
  volume: Ref<number>
  loadSong: (song: ISongInfo | null) => void
  syncDefaultCue: (song: ISongInfo | null, force?: boolean) => void
  seekTo: (seconds: number) => void
  setVolume: (volume: number) => void
  togglePlayPause: () => void
  cue: (song: ISongInfo | null) => void
  stop: () => void
  destroy: () => void
  matchesRequestId: (requestId: string) => boolean
  handleDecodedPayload: (payload: DecodePayload, filePath: string) => void
  handleLoadError: (filePath: string, message?: string) => void
}

const normalizeRequestId = (value: unknown) => String(value || '').trim()

const createDeckController = (deck: HorizontalBrowseDeckKey): CreateDeckControllerResult => {
  const player = new WebAudioPlayer()
  const currentSeconds = ref(0)
  const durationSeconds = ref(0)
  const playing = ref(false)
  const ready = ref(false)
  const cuePointSeconds = ref(0)
  const volume = ref(1)
  const cueCustomized = ref(false)
  let requestSerial = 0
  let activeRequestId = ''
  let activeFilePath = ''
  let lastPublishedAt = 0

  player.setVolume(volume.value)

  const resetState = () => {
    currentSeconds.value = 0
    durationSeconds.value = 0
    playing.value = false
    ready.value = false
    cuePointSeconds.value = 0
    cueCustomized.value = false
    lastPublishedAt = 0
  }

  const publishCurrentSeconds = (seconds: number, force = false) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
    const now = performance.now()
    if (
      force ||
      !playing.value ||
      now - lastPublishedAt >= PLAYBACK_STATE_PUBLISH_INTERVAL_MS ||
      Math.abs(currentSeconds.value - safe) >= 0.25
    ) {
      currentSeconds.value = safe
      lastPublishedAt = now
    }
  }

  const syncDefaultCue = (song: ISongInfo | null, force = false) => {
    if (!force && cueCustomized.value) return
    cuePointSeconds.value = resolveHorizontalBrowseDefaultCuePointSec(
      song,
      durationSeconds.value || player.getDuration()
    )
  }

  const syncDuration = (duration?: number) => {
    const nextDuration =
      typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? duration
        : player.getDuration()
    durationSeconds.value = Number.isFinite(nextDuration) && nextDuration > 0 ? nextDuration : 0
  }

  player.on('play', () => {
    playing.value = true
    publishCurrentSeconds(player.getCurrentTime(), true)
  })
  player.on('pause', () => {
    playing.value = false
    publishCurrentSeconds(player.getCurrentTime(), true)
  })
  player.on('finish', () => {
    playing.value = false
    syncDuration()
    publishCurrentSeconds(durationSeconds.value, true)
  })
  player.on('timeupdate', (time) => {
    publishCurrentSeconds(time)
  })
  player.on('decode', (duration) => {
    syncDuration(duration)
  })
  player.on('ready', () => {
    ready.value = true
    syncDuration()
  })
  player.on('seeked', ({ time }) => {
    publishCurrentSeconds(time, true)
  })
  player.on('error', (error) => {
    console.warn(`[horizontal-browse:${deck}] 播放器错误`, error)
  })

  const stop = () => {
    activeRequestId = ''
    activeFilePath = ''
    try {
      player.stop()
      player.empty()
    } catch {}
    resetState()
  }

  const loadSong = (song: ISongInfo | null) => {
    stop()
    const filePath = String(song?.filePath || '').trim()
    if (!filePath) return

    cueCustomized.value = false
    syncDefaultCue(song, true)
    activeFilePath = filePath
    requestSerial += 1
    activeRequestId = `horizontal-browse:${deck}:${requestSerial}`

    try {
      if (canPlayHtmlAudio(filePath)) {
        player.loadFile(filePath)
      } else {
        window.electron.ipcRenderer.send('readSongFile', filePath, activeRequestId)
      }
    } catch (error) {
      console.warn(`[horizontal-browse:${deck}] 加载失败`, error)
    }
  }

  const togglePlayPause = () => {
    if (!activeFilePath) return
    if (player.isPlaying()) {
      player.pause()
      return
    }
    player.play(currentSeconds.value)
  }

  const seekTo = (seconds: number) => {
    if (!activeFilePath) return
    player.seek(seconds, true)
    publishCurrentSeconds(seconds, true)
  }

  const cue = (song: ISongInfo | null) => {
    if (!activeFilePath) return
    if (player.isPlaying()) {
      player.pause()
      player.seek(cuePointSeconds.value, true)
      currentSeconds.value = cuePointSeconds.value
      return
    }

    const nextCuePoint = resolveHorizontalBrowseCuePointSec(
      song,
      player.getCurrentTime(),
      durationSeconds.value || player.getDuration()
    )
    cueCustomized.value = true
    cuePointSeconds.value = nextCuePoint
    player.pause()
    player.seek(nextCuePoint, true)
    currentSeconds.value = nextCuePoint
  }

  const setVolume = (nextVolume: number) => {
    const safeVolume = Number.isFinite(nextVolume) && nextVolume >= 0 ? Math.min(1, nextVolume) : 0
    volume.value = safeVolume
    player.setVolume(safeVolume)
  }

  const matchesRequestId = (requestId: string) =>
    normalizeRequestId(requestId) !== '' && normalizeRequestId(requestId) === activeRequestId

  const handleDecodedPayload = (payload: DecodePayload, filePath: string) => {
    if (!activeFilePath || activeFilePath !== String(filePath || '').trim()) return
    try {
      player.loadPCM({
        pcmData: payload?.pcmData ?? new Float32Array(0),
        sampleRate: payload?.sampleRate ?? 0,
        channels: payload?.channels ?? 1,
        totalFrames: payload?.totalFrames ?? 0,
        mixxxWaveformData: payload?.mixxxWaveformData ?? null,
        filePath
      })
    } catch (error) {
      console.warn(`[horizontal-browse:${deck}] PCM 加载失败`, error)
    }
  }

  const handleLoadError = (filePath: string, message?: string) => {
    if (!activeFilePath || activeFilePath !== String(filePath || '').trim()) return
    console.warn(`[horizontal-browse:${deck}] 读取歌曲失败`, message || '')
    resetState()
  }

  const destroy = () => {
    stop()
    player.destroy()
  }

  return {
    currentSeconds,
    durationSeconds,
    playing,
    ready,
    cuePointSeconds,
    volume,
    loadSong,
    syncDefaultCue,
    seekTo,
    setVolume,
    togglePlayPause,
    cue,
    stop,
    destroy,
    matchesRequestId,
    handleDecodedPayload,
    handleLoadError
  }
}

export const useHorizontalBrowseDeckPlayers = () => {
  const topDeck = createDeckController('top')
  const bottomDeck = createDeckController('bottom')

  const handleReadedSongFile = (
    _event: unknown,
    payload: DecodePayload,
    filePath: string,
    requestId: string
  ) => {
    if (topDeck.matchesRequestId(requestId)) {
      topDeck.handleDecodedPayload(payload, filePath)
      return
    }
    if (bottomDeck.matchesRequestId(requestId)) {
      bottomDeck.handleDecodedPayload(payload, filePath)
    }
  }

  const handleReadSongFileError = (
    _event: unknown,
    filePath: string,
    message: string,
    requestId: string
  ) => {
    if (topDeck.matchesRequestId(requestId)) {
      topDeck.handleLoadError(filePath, message)
      return
    }
    if (bottomDeck.matchesRequestId(requestId)) {
      bottomDeck.handleLoadError(filePath, message)
    }
  }

  window.electron.ipcRenderer.on('readedSongFile', handleReadedSongFile)
  window.electron.ipcRenderer.on('readSongFileError', handleReadSongFileError)

  onBeforeUnmount(() => {
    window.electron.ipcRenderer.removeListener('readedSongFile', handleReadedSongFile)
    window.electron.ipcRenderer.removeListener('readSongFileError', handleReadSongFileError)
    topDeck.destroy()
    bottomDeck.destroy()
  })

  return {
    topDeckCurrentSeconds: topDeck.currentSeconds,
    topDeckDurationSeconds: topDeck.durationSeconds,
    topDeckPlaying: topDeck.playing,
    topDeckCuePointSeconds: topDeck.cuePointSeconds,
    topDeckVolume: topDeck.volume,
    bottomDeckCurrentSeconds: bottomDeck.currentSeconds,
    bottomDeckDurationSeconds: bottomDeck.durationSeconds,
    bottomDeckPlaying: bottomDeck.playing,
    bottomDeckCuePointSeconds: bottomDeck.cuePointSeconds,
    bottomDeckVolume: bottomDeck.volume,
    loadDeckSong: (deck: HorizontalBrowseDeckKey, song: ISongInfo | null) => {
      if (deck === 'top') {
        topDeck.loadSong(song)
        return
      }
      bottomDeck.loadSong(song)
    },
    syncDeckDefaultCue: (deck: HorizontalBrowseDeckKey, song: ISongInfo | null, force = false) => {
      if (deck === 'top') {
        topDeck.syncDefaultCue(song, force)
        return
      }
      bottomDeck.syncDefaultCue(song, force)
    },
    seekDeck: (deck: HorizontalBrowseDeckKey, seconds: number) => {
      if (deck === 'top') {
        topDeck.seekTo(seconds)
        return
      }
      bottomDeck.seekTo(seconds)
    },
    setDeckVolume: (deck: HorizontalBrowseDeckKey, volume: number) => {
      if (deck === 'top') {
        topDeck.setVolume(volume)
        return
      }
      bottomDeck.setVolume(volume)
    },
    toggleDeckPlayPause: (deck: HorizontalBrowseDeckKey) => {
      if (deck === 'top') {
        topDeck.togglePlayPause()
        return
      }
      bottomDeck.togglePlayPause()
    },
    cueDeck: (deck: HorizontalBrowseDeckKey, song: ISongInfo | null) => {
      if (deck === 'top') {
        topDeck.cue(song)
        return
      }
      bottomDeck.cue(song)
    },
    stopDeck: (deck: HorizontalBrowseDeckKey) => {
      if (deck === 'top') {
        topDeck.stop()
        return
      }
      bottomDeck.stop()
    }
  }
}
