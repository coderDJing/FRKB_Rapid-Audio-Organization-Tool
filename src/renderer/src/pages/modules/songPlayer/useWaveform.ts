import { onMounted, onUnmounted, watch, type Ref } from 'vue'
import { WebAudioPlayer, type WebAudioPlayerEvents } from './webAudioPlayer'

export function useWaveform(params: {
  waveformEl: Ref<HTMLDivElement | null>
  audioPlayer: Ref<WebAudioPlayer | null>
  runtime: any
  updateParentWaveformWidth: () => void
  onNextSong: () => void
  schedulePreloadAfterPlay: () => void
  cancelPreloadTimer: () => void
  playerControlsRef?: { value?: { setPlayingValue?: (v: boolean) => void } | null }
  onError?: (error: any) => void
}) {
  const {
    waveformEl,
    audioPlayer,
    runtime,
    updateParentWaveformWidth,
    onNextSong,
    schedulePreloadAfterPlay,
    cancelPreloadTimer,
    playerControlsRef,
    onError
  } = params

  const waveformHeight = 40
  const barWidth = 2
  const barGap = 1
  const cursorWidth = 1

  const canvasContainer = document.createElement('div')
  canvasContainer.style.position = 'relative'
  canvasContainer.style.width = '100%'
  canvasContainer.style.height = `${waveformHeight}px`
  canvasContainer.style.pointerEvents = 'auto'

  const baseCanvas = document.createElement('canvas')
  const progressCanvas = document.createElement('canvas')
  const progressWrapper = document.createElement('div')
  const cursorEl = document.createElement('div')
  const interactionLayer = document.createElement('div')

  baseCanvas.style.position = 'absolute'
  baseCanvas.style.top = '0'
  baseCanvas.style.left = '0'
  baseCanvas.style.zIndex = '1'
  baseCanvas.style.display = 'block'
  baseCanvas.style.pointerEvents = 'none'

  progressWrapper.style.position = 'absolute'
  progressWrapper.style.top = '0'
  progressWrapper.style.left = '0'
  progressWrapper.style.height = '100%'
  progressWrapper.style.width = '0%'
  progressWrapper.style.overflow = 'hidden'
  progressWrapper.style.zIndex = '2'
  progressWrapper.style.pointerEvents = 'none'

  progressCanvas.style.position = 'absolute'
  progressCanvas.style.top = '0'
  progressCanvas.style.left = '0'
  progressCanvas.style.display = 'block'
  progressCanvas.style.pointerEvents = 'none'

  cursorEl.style.position = 'absolute'
  cursorEl.style.top = '0'
  cursorEl.style.left = '0'
  cursorEl.style.height = '100%'
  cursorEl.style.width = `${cursorWidth}px`
  cursorEl.style.background = '#0078d4'
  cursorEl.style.zIndex = '3'
  cursorEl.style.pointerEvents = 'none'
  cursorEl.style.transform = 'translateX(-50%)'

  interactionLayer.style.position = 'absolute'
  interactionLayer.style.top = '0'
  interactionLayer.style.left = '0'
  interactionLayer.style.width = '100%'
  interactionLayer.style.height = '100%'
  interactionLayer.style.zIndex = '4'
  interactionLayer.style.cursor = 'pointer'
  interactionLayer.style.background = 'transparent'

  const baseCtx = baseCanvas.getContext('2d')
  const progressCtx = progressCanvas.getContext('2d')
  if (!baseCtx || !progressCtx) throw new Error('canvas context is null')

  canvasContainer.appendChild(baseCanvas)
  progressWrapper.appendChild(progressCanvas)
  canvasContainer.appendChild(progressWrapper)
  canvasContainer.appendChild(cursorEl)
  canvasContainer.appendChild(interactionLayer)

  let animationFrameId: number | null = null
  let audioBuffer: AudioBuffer | null = null
  let minMaxData: Array<{ min: number; max: number }> | null = null
  let hoverEl: HTMLElement | null = null
  let isPointerDown = false
  type AudioEventName = keyof WebAudioPlayerEvents
  const audioEventHandlers: Array<{
    player: WebAudioPlayer
    event: AudioEventName
    handler: (...args: any[]) => void
  }> = []

  const registerPlayerHandler = (
    player: WebAudioPlayer,
    event: AudioEventName,
    handler: (...args: any[]) => void
  ) => {
    player.on(event as any, handler as any)
    audioEventHandlers.push({ player, event, handler })
  }

  const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

  const getPercentFromClientX = (clientX: number) => {
    const rect = canvasContainer.getBoundingClientRect()
    if (!rect.width) return 0
    return clamp01((clientX - rect.left) / rect.width)
  }

  const syncHoverOverlay = (percent: number) => {
    if (hoverEl) {
      hoverEl.style.width = `${percent * 100}%`
    }
  }

  const seekToPercent = (percent: number) => {
    if (!audioPlayer.value) return
    const duration = audioPlayer.value.getDuration()
    if (duration > 0 && Number.isFinite(duration)) {
      audioPlayer.value.seek(duration * percent)
    }
  }

  const handlePointerMove = (event: PointerEvent) => {
    const percent = getPercentFromClientX(event.clientX)
    syncHoverOverlay(percent)
    if (isPointerDown) {
      seekToPercent(percent)
    }
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    isPointerDown = true
    try {
      interactionLayer.setPointerCapture(event.pointerId)
    } catch {}
    const percent = getPercentFromClientX(event.clientX)
    seekToPercent(percent)
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (isPointerDown) {
      isPointerDown = false
      try {
        interactionLayer.releasePointerCapture(event.pointerId)
      } catch {}
    }
  }

  const handlePointerLeave = () => {
    if (!isPointerDown) {
      syncHoverOverlay(0)
    }
  }

  interactionLayer.addEventListener('pointermove', handlePointerMove)
  interactionLayer.addEventListener('pointerdown', handlePointerDown)
  interactionLayer.addEventListener('pointerup', handlePointerUp)
  interactionLayer.addEventListener('pointercancel', handlePointerUp)
  interactionLayer.addEventListener('pointerleave', handlePointerLeave)

  const handleResize = () => {
    updateWaveform()
  }

  const updateProgressVisual = (progress: number) => {
    const clamped = Math.max(0, Math.min(1, progress || 0))
    const percent = clamped * 100
    progressWrapper.style.clipPath = ''
    progressWrapper.style.width = `${percent}%`
    progressWrapper.style.transform = `translateX(0)`
    cursorEl.style.left = `${percent}%`
  }

  const resizeCanvas = (
    targetCanvas: HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.floor(height * pixelRatio)

    if (targetCanvas.width !== scaledWidth || targetCanvas.height !== scaledHeight) {
      targetCanvas.width = scaledWidth
      targetCanvas.height = scaledHeight
    }

    targetCanvas.style.width = `${width}px`
    targetCanvas.style.height = `${height}px`

    targetCtx.setTransform(1, 0, 0, 1, 0, 0)
    targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
    targetCtx.scale(pixelRatio, pixelRatio)
  }

  const drawWaveform = (forceRedraw = false) => {
    if (!waveformEl.value || !audioPlayer.value) return

    const container = waveformEl.value
    const width = container.clientWidth || 1
    const height = waveformHeight

    const duration = audioBuffer?.duration ?? 0
    const currentTime = audioPlayer.value?.getCurrentTime?.() ?? 0
    const progress = duration > 0 ? currentTime / duration : 0
    updateProgressVisual(progress)

    if (!forceRedraw) {
      return
    }

    if (!minMaxData || !audioBuffer) {
      baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
      progressCtx.clearRect(0, 0, progressCanvas.width, progressCanvas.height)
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const totalBars = Math.max(1, Math.floor(width / (barWidth + barGap)))
    const samplesPerBar = Math.max(1, Math.floor(minMaxData.length / totalBars))

    const midY = height / 2
    const baseGradient = baseCtx.createLinearGradient(0, 0, 0, height)
    baseGradient.addColorStop(0, '#cccccc')
    baseGradient.addColorStop(1, '#cccccc')

    const progressGradient = progressCtx.createLinearGradient(0, 0, 0, height)
    progressGradient.addColorStop(0, '#0078d4')
    progressGradient.addColorStop(1, '#0078d4')

    const bars: Array<{ x: number; barMin: number; rectHeight: number }> = []

    for (let barIndex = 0; barIndex < totalBars; barIndex++) {
      const start = barIndex * samplesPerBar
      const end = Math.min(start + samplesPerBar, minMaxData.length)
      if (start >= end) continue

      let min = 1
      let max = -1
      for (let i = start; i < end; i++) {
        const { min: currentMin, max: currentMax } = minMaxData[i]
        if (currentMin < min) min = currentMin
        if (currentMax > max) max = currentMax
      }

      const barMin = midY + min * midY
      const barMax = midY + max * midY
      const rectHeight = Math.max(1, barMax - barMin)

      const x = barIndex * (barWidth + barGap)
      bars.push({ x, barMin, rectHeight })
    }

    baseCtx.fillStyle = baseGradient
    for (const { x, barMin, rectHeight } of bars) {
      baseCtx.fillRect(x, barMin, barWidth, rectHeight)
    }

    progressCtx.fillStyle = progressGradient
    for (const { x, barMin, rectHeight } of bars) {
      progressCtx.fillRect(x, barMin, barWidth, rectHeight)
    }
  }

  let ro: ResizeObserver | null = null

  const updateWaveform = () => {
    if (!audioPlayer.value) return
    // 从 AudioBuffer 生成波形数据
    const buffer = audioPlayer.value.audioBuffer
    if (!buffer) {
      minMaxData = null
      audioBuffer = null
      baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
      progressCtx.clearRect(0, 0, progressCanvas.width, progressCanvas.height)
      updateProgressVisual(0)
      syncHoverOverlay(0)
      return
    }

    audioBuffer = buffer
    const channelData = buffer.getChannelData(0) // 使用第一个声道
    const samples = channelData.length
    const downsampleFactor = Math.max(1, Math.floor(samples / 2000)) // 降采样到约2000个点

    const length = Math.min(5000, Math.floor(samples / downsampleFactor))
    minMaxData = new Array(length)
    for (let i = 0; i < length; i++) {
      const start = i * downsampleFactor
      const end = Math.min(start + downsampleFactor, samples)
      let min = 1
      let max = -1
      for (let j = start; j < end; j++) {
        const v = channelData[j]
        if (v < min) min = v
        if (v > max) max = v
      }
      minMaxData[i] = { min, max }
    }

    drawWaveform(true)
  }

  const animate = () => {
    const isPlaying = audioPlayer.value?.isPlaying() ?? false
    if (isPlaying) {
      drawWaveform()
    }
    animationFrameId = requestAnimationFrame(animate)
  }

  const attachEventListeners = () => {
    const player = audioPlayer.value
    if (!player) return
    const getTimeEl = () => document.querySelector('#time') as HTMLElement | null
    const getDurationEl = () => document.querySelector('#duration') as HTMLElement | null

    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    const updateDurationDisplay = (seconds: number) => {
      const el = getDurationEl()
      if (el) el.textContent = formatTime(seconds)
    }

    const updateTimeDisplay = (seconds: number) => {
      const el = getTimeEl()
      if (el) el.textContent = formatTime(seconds)
    }

    const handleDecode = (duration: number) => {
      updateDurationDisplay(duration)
      updateParentWaveformWidth()
      updateWaveform()
      setTimeout(() => {
        updateParentWaveformWidth()
        updateWaveform()
      }, 50)
    }

    const handleReady = () => {
      const playerDuration = audioPlayer.value?.getDuration?.()
      if (typeof playerDuration === 'number') {
        updateDurationDisplay(playerDuration)
      }
      updateParentWaveformWidth()
      updateWaveform()
      setTimeout(() => {
        updateParentWaveformWidth()
        updateWaveform()
      }, 50)
    }

    const handlePlay = () => {
      playerControlsRef?.value?.setPlayingValue?.(true)
      cancelPreloadTimer()
      schedulePreloadAfterPlay()
      runtime.playerReady = true
      runtime.isSwitchingSong = false
    }

    const handlePause = () => {
      cancelPreloadTimer()
      playerControlsRef?.value?.setPlayingValue?.(false)
      drawWaveform()
    }

    const handleTimeUpdate = (currentTime: number) => {
      drawWaveform()
      updateTimeDisplay(currentTime)
    }

    const handleFinish = () => {
      cancelPreloadTimer()
      if (runtime.setting.autoPlayNextSong) onNextSong()
      drawWaveform()
    }

    registerPlayerHandler(player, 'decode', handleDecode)
    registerPlayerHandler(player, 'ready', handleReady)
    const handleSeeked = (currentTime: number) => {
      drawWaveform()
      updateTimeDisplay(currentTime)
    }

    registerPlayerHandler(player, 'play', handlePlay)
    registerPlayerHandler(player, 'pause', handlePause)
    registerPlayerHandler(player, 'timeupdate', handleTimeUpdate)
    registerPlayerHandler(player, 'seeked', handleSeeked)
    registerPlayerHandler(player, 'finish', handleFinish)

    if (onError) {
      const handleError = (error: any) => {
        onError(error)
      }
      registerPlayerHandler(player, 'error', handleError)
    }
  }

  const detachEventListeners = () => {
    if (audioEventHandlers.length) {
      for (const { player, event, handler } of audioEventHandlers) {
        try {
          player.off(event as any, handler as any)
        } catch {}
      }
      audioEventHandlers.length = 0
    }
  }

  watch(
    () => waveformEl.value,
    (newEl) => {
      if (newEl) {
        if (!canvasContainer.parentNode) {
          if (newEl.firstChild) newEl.insertBefore(canvasContainer, newEl.firstChild)
          else newEl.appendChild(canvasContainer)
        }
        if (!baseCanvas.parentNode) {
          canvasContainer.appendChild(baseCanvas)
        }
        if (!progressWrapper.parentNode) {
          canvasContainer.appendChild(progressWrapper)
        }
        if (!progressCanvas.parentNode) {
          progressWrapper.appendChild(progressCanvas)
        }
        if (!cursorEl.parentNode) {
          canvasContainer.appendChild(cursorEl)
        }
        if (!interactionLayer.parentNode) {
          canvasContainer.appendChild(interactionLayer)
        }
        hoverEl = newEl.querySelector('#hover')
        canvasContainer.style.height = `${waveformHeight}px`
        // 观察容器尺寸变化，防止首次为 0 宽导致不渲染
        try {
          if (ro) ro.disconnect()
          ro = new ResizeObserver(() => {
            // 宽度变化时重绘
            updateWaveform()
          })
          ro.observe(newEl)
        } catch {}
      } else {
        hoverEl = null
        if (ro) {
          try {
            ro.disconnect()
          } catch {}
          ro = null
        }
      }
    },
    { immediate: true }
  )

  watch(
    () => audioPlayer.value,
    () => {
      detachEventListeners()
      attachEventListeners()
    },
    { immediate: true }
  )

  watch(
    () => runtime.setting.hiddenPlayControlArea,
    () => {
      if (waveformEl.value) {
        setTimeout(() => {
          updateWaveform()
        }, 100)
      }
    }
  )

  onMounted(() => {
    attachEventListeners()
    if (animationFrameId === null) {
      animationFrameId = requestAnimationFrame(animate)
    }
    window.addEventListener('resize', handleResize)
  })

  onUnmounted(() => {
    detachEventListeners()
    window.removeEventListener('resize', handleResize)
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    if (ro) {
      try {
        ro.disconnect()
      } catch {}
      ro = null
    }
    interactionLayer.removeEventListener('pointermove', handlePointerMove)
    interactionLayer.removeEventListener('pointerdown', handlePointerDown)
    interactionLayer.removeEventListener('pointerup', handlePointerUp)
    interactionLayer.removeEventListener('pointercancel', handlePointerUp)
    interactionLayer.removeEventListener('pointerleave', handlePointerLeave)
    hoverEl = null
    if (canvasContainer.parentNode) {
      canvasContainer.parentNode.removeChild(canvasContainer)
    }
  })

  return {
    updateWaveform,
    drawWaveform
  }
}
