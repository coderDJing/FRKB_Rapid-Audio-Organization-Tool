import { onBeforeUnmount, ref } from 'vue'

type SyncPlaybackStateParams = {
  seconds: number
  playing: boolean
  songKey: string
}

type UseHorizontalBrowsePlaybackAnimationOptions = {
  onFrame: (seconds: number) => void
}

const RESYNC_DRIFT_THRESHOLD_SEC = 0.06

export const useHorizontalBrowsePlaybackAnimation = (
  options: UseHorizontalBrowsePlaybackAnimationOptions
) => {
  const syncedSeconds = ref(0)
  const animatedSeconds = ref(0)
  let rafId = 0
  let lastFrameTime = 0
  let activeSongKey = ''
  let playing = false

  const renderFrame = (seconds: number) => {
    const safe = Math.max(0, Number(seconds) || 0)
    animatedSeconds.value = safe
    options.onFrame(safe)
  }

  const stopPlaybackAnimation = () => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    lastFrameTime = 0
  }

  const step = (timestamp: number) => {
    if (!playing) {
      stopPlaybackAnimation()
      return
    }
    if (lastFrameTime > 0) {
      const deltaSec = Math.max(0, (timestamp - lastFrameTime) / 1000)
      animatedSeconds.value += deltaSec
    }
    if (Math.abs(animatedSeconds.value - syncedSeconds.value) > RESYNC_DRIFT_THRESHOLD_SEC) {
      animatedSeconds.value = syncedSeconds.value
    }
    lastFrameTime = timestamp
    renderFrame(animatedSeconds.value)
    rafId = requestAnimationFrame(step)
  }

  const syncPlaybackState = ({
    seconds,
    playing: nextPlaying,
    songKey
  }: SyncPlaybackStateParams) => {
    const safeSongKey = String(songKey || '').trim()
    const safeSeconds = Math.max(0, Number(seconds) || 0)
    const songChanged = safeSongKey !== activeSongKey
    activeSongKey = safeSongKey
    syncedSeconds.value = safeSeconds
    playing = !!nextPlaying && !!safeSongKey

    if (!safeSongKey) {
      stopPlaybackAnimation()
      renderFrame(0)
      return
    }

    if (songChanged) {
      stopPlaybackAnimation()
      renderFrame(safeSeconds)
    }

    if (!playing) {
      stopPlaybackAnimation()
      renderFrame(safeSeconds)
      return
    }

    if (!rafId) {
      renderFrame(safeSeconds)
      lastFrameTime = 0
      rafId = requestAnimationFrame(step)
    }
  }

  onBeforeUnmount(() => {
    stopPlaybackAnimation()
  })

  return {
    syncPlaybackState,
    stopPlaybackAnimation
  }
}
