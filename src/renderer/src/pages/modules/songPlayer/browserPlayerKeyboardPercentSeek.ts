type KeyboardPercentSeekPlayer = {
  getDuration: () => number
  seek: (time: number, manual?: boolean) => void
  deferMetadataPreloadsForManualSeek?: () => void
}

type KeyboardPercentSeekPending = {
  percent: number
  filePath?: string
}

type KeyboardPercentSeekOptions = {
  getPlayer: () => KeyboardPercentSeekPlayer | null
  getFilePath: () => string | undefined
  isAllowed: () => boolean
}

const REQUEST_COMMIT_DELAY_MS = 80

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export const createBrowserPlayerKeyboardPercentSeek = (options: KeyboardPercentSeekOptions) => {
  let timer: number | null = null
  let pending: KeyboardPercentSeekPending | null = null

  const clearTimer = () => {
    if (timer === null) return
    window.clearTimeout(timer)
    timer = null
  }

  const resetBurst = () => {
    pending = null
  }

  const flush = () => {
    const target = pending
    clearTimer()
    if (!target) return

    if (!options.isAllowed()) {
      resetBurst()
      return
    }

    const currentFilePath = options.getFilePath()
    if (target.filePath && currentFilePath && target.filePath !== currentFilePath) {
      resetBurst()
      return
    }

    const player = options.getPlayer()
    const duration = player?.getDuration?.() ?? 0
    if (!player || duration <= 0 || !Number.isFinite(duration)) {
      resetBurst()
      return
    }

    const targetSec = duration * target.percent
    player.seek(targetSec, true)
    resetBurst()
  }

  const scheduleFlush = (delayMs: number) => {
    clearTimer()
    timer = window.setTimeout(() => {
      flush()
    }, delayMs)
  }

  const request = (percent: number) => {
    if (!options.isAllowed()) return

    const player = options.getPlayer()
    if (!player) return

    const clampedPercent = clamp01(percent)
    const filePath = options.getFilePath()

    pending = {
      percent: clampedPercent,
      filePath
    }

    player.deferMetadataPreloadsForManualSeek?.()

    scheduleFlush(REQUEST_COMMIT_DELAY_MS)
  }

  const clear = (_reason = 'clear') => {
    clearTimer()
    resetBurst()
  }

  return {
    request,
    clear
  }
}

export type BrowserPlayerKeyboardPercentSeek = ReturnType<
  typeof createBrowserPlayerKeyboardPercentSeek
>
