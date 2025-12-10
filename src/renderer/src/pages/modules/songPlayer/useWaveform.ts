import { onMounted, onUnmounted, watch, type Ref } from 'vue'
import {
  WebAudioPlayer,
  type RGBWaveformBandKey,
  type RGBWaveformData,
  type WaveformStyle,
  type WebAudioPlayerEvents
} from './webAudioPlayer'

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
  const fineBarWidth = 1.5
  const barGap = 1
  const cursorWidth = 1
  const WAVEFORM_STYLE_SOUND_CLOUD: WaveformStyle = 'SoundCloud'
  const WAVEFORM_STYLE_FINE: WaveformStyle = 'Fine'
  const WAVEFORM_STYLE_RGB: WaveformStyle = 'RGB'
  const REKORDBOX_MINI_POINTS_PER_SECOND = 300
  const RGB_BASE_ALPHA = 0.68
  const RGB_PROGRESS_ALPHA = 0.98
  const REKORDBOX_RGB_COLORS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
    low: { r: 255, g: 50, b: 30 }, // 更纯的低频红
    mid: { r: 50, g: 255, b: 60 }, // 更亮的中频绿
    high: { r: 60, g: 180, b: 255 } // 偏青蓝的高频
  }
  const RGB_BAND_INTENSITY_EXP: Record<RGBWaveformBandKey, number> = {
    low: 0.9,
    mid: 0.82,
    high: 0.75
  }
  const RGB_BAND_AMPLITUDE_WEIGHT: Record<RGBWaveformBandKey, number> = {
    low: 0.9,
    mid: 0.5,
    high: 0.8
  }
  const normalizeWaveformStyle = (style?: WaveformStyle | 'RekordboxMini'): WaveformStyle => {
    if (style === 'RekordboxMini') return WAVEFORM_STYLE_RGB
    if (
      style === WAVEFORM_STYLE_RGB ||
      style === WAVEFORM_STYLE_FINE ||
      style === WAVEFORM_STYLE_SOUND_CLOUD
    ) {
      return style
    }
    return WAVEFORM_STYLE_SOUND_CLOUD
  }

  type ColumnMetrics = {
    amplitude: number
    amplitudeRatio: number
    low: number
    mid: number
    high: number
    color: { r: number; g: number; b: number }
  }

  const getWaveformStyle = (): WaveformStyle => {
    return normalizeWaveformStyle(runtime.setting?.waveformStyle)
  }

  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'

  const computeColumnMetrics = (
    columnCount: number,
    waveformData: RGBWaveformData | null
  ): ColumnMetrics[] => {
    if (!waveformData || columnCount <= 0) return []

    const lowLen = waveformData.bands.low?.values.length ?? 0
    const midLen = waveformData.bands.mid?.values.length ?? 0
    const highLen = waveformData.bands.high?.values.length ?? 0
    const totalPoints = Math.min(lowLen, midLen, highLen)
    if (totalPoints === 0) {
      return []
    }

    const duration = waveformData.duration || 0
    const targetPoints =
      duration > 0
        ? Math.max(1, Math.floor(duration * REKORDBOX_MINI_POINTS_PER_SECOND))
        : totalPoints
    const reductionStride = Math.max(1, Math.floor(totalPoints / targetPoints))
    const effectiveTotalPoints = Math.max(1, Math.floor(totalPoints / reductionStride))

    const samplesPerColumn = Math.max(1, effectiveTotalPoints / Math.max(1, columnCount))
    const smoothSamples = Math.max(2, Math.min(6, Math.floor(samplesPerColumn * 1.5)))

    const getBandIntensity = (band: RGBWaveformBandKey, index: number) => {
      const bandData = waveformData.bands[band]
      if (!bandData || !bandData.values.length) return 0
      const peak = bandData.peak || 1
      if (!peak) return 0
      const value = bandData.values[Math.min(index, bandData.values.length - 1)]
      const normalized = Math.max(0, Math.min(1, value / peak))
      const exponent = RGB_BAND_INTENSITY_EXP[band] ?? 1
      return Math.pow(normalized, exponent)
    }

    const columns: ColumnMetrics[] = new Array(columnCount)

    for (let x = 0; x < columnCount; x++) {
      const windowStart = Math.min(
        totalPoints - 1,
        Math.floor(x * samplesPerColumn) * reductionStride
      )
      const windowEnd = Math.min(totalPoints, windowStart + smoothSamples * reductionStride)
      let lowPeak = 0
      let midPeak = 0
      let highPeak = 0
      let lowSq = 0
      let midSq = 0
      let highSq = 0
      let count = 0

      for (let i = windowStart; i < windowEnd; i += reductionStride) {
        const lowVal = getBandIntensity('low', i)
        const midVal = getBandIntensity('mid', i)
        const highVal = getBandIntensity('high', i)
        lowPeak = Math.max(lowPeak, lowVal)
        midPeak = Math.max(midPeak, midVal)
        highPeak = Math.max(highPeak, highVal)
        lowSq += lowVal * lowVal
        midSq += midVal * midVal
        highSq += highVal * highVal
        count++
      }

      const safeCount = count || 1
      const lowRms = Math.sqrt(lowSq / safeCount)
      const midRms = Math.sqrt(midSq / safeCount)
      const highRms = Math.sqrt(highSq / safeCount)

      const lowIntensity = (lowRms * 0.7 + lowPeak * 0.3) * 0.9
      const midIntensity = (midRms * 0.75 + midPeak * 0.25) * 0.6
      const highIntensity = (highRms * 0.7 + highPeak * 0.3) * 0.7

      const weightedEnergy =
        lowIntensity * RGB_BAND_AMPLITUDE_WEIGHT.low +
        midIntensity * RGB_BAND_AMPLITUDE_WEIGHT.mid +
        highIntensity * RGB_BAND_AMPLITUDE_WEIGHT.high

      const amplitudeRatio = Math.min(1, Math.pow(weightedEnergy, 0.42))
      const lowFloor = Math.max(0, Math.pow(lowIntensity, 0.82) * 0.08)
      let amplitude = Math.max(0, amplitudeRatio * 0.7 + lowFloor)
      amplitude *= 1 + 0.45 * amplitudeRatio

      let domBand: RGBWaveformBandKey = 'low'
      let domValue = lowIntensity
      if (midIntensity >= domValue && midIntensity >= highIntensity) {
        domBand = 'mid'
        domValue = midIntensity
      } else if (highIntensity >= domValue) {
        domBand = 'high'
        domValue = highIntensity
      }

      const domColor = REKORDBOX_RGB_COLORS[domBand]
      const otherSum = lowIntensity + midIntensity + highIntensity - domValue
      const otherColor =
        otherSum > 0
          ? {
              r:
                (REKORDBOX_RGB_COLORS.low.r * (domBand === 'low' ? 0 : lowIntensity) +
                  REKORDBOX_RGB_COLORS.mid.r * (domBand === 'mid' ? 0 : midIntensity) +
                  REKORDBOX_RGB_COLORS.high.r * (domBand === 'high' ? 0 : highIntensity)) /
                otherSum,
              g:
                (REKORDBOX_RGB_COLORS.low.g * (domBand === 'low' ? 0 : lowIntensity) +
                  REKORDBOX_RGB_COLORS.mid.g * (domBand === 'mid' ? 0 : midIntensity) +
                  REKORDBOX_RGB_COLORS.high.g * (domBand === 'high' ? 0 : highIntensity)) /
                otherSum,
              b:
                (REKORDBOX_RGB_COLORS.low.b * (domBand === 'low' ? 0 : lowIntensity) +
                  REKORDBOX_RGB_COLORS.mid.b * (domBand === 'mid' ? 0 : midIntensity) +
                  REKORDBOX_RGB_COLORS.high.b * (domBand === 'high' ? 0 : highIntensity)) /
                otherSum
            }
          : domColor

      const mixedR = domColor.r * 0.7 + otherColor.r * 0.3
      const mixedG = domColor.g * 0.7 + otherColor.g * 0.3
      const mixedB = domColor.b * 0.7 + otherColor.b * 0.3
      const brightness = Math.min(1.4, 0.55 + amplitudeRatio * 0.75 + domValue * 0.45)
      const r = Math.min(255, Math.round(mixedR * 1.15 * brightness))
      const g = Math.min(255, Math.round(mixedG * 1.2 * brightness))
      const b = Math.min(255, Math.round(mixedB * 1.08 * brightness))

      columns[x] = {
        amplitude,
        amplitudeRatio,
        low: lowIntensity,
        mid: midIntensity,
        high: highIntensity,
        color: { r, g, b }
      }
    }

    return columns
  }

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
      audioPlayer.value.seek(duration * percent, true)
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

  const clearCanvases = () => {
    baseCtx.setTransform(1, 0, 0, 1, 0, 0)
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
    progressCtx.setTransform(1, 0, 0, 1, 0, 0)
    progressCtx.clearRect(0, 0, progressCanvas.width, progressCanvas.height)
  }

  const drawBarWaveform = (
    width: number,
    height: number,
    style: WaveformStyle,
    waveformData: RGBWaveformData | null
  ) => {
    if (!waveformData) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const targetBarWidth = style === WAVEFORM_STYLE_FINE ? fineBarWidth : barWidth
    const targetGap = style === WAVEFORM_STYLE_FINE ? barGap * 0.3 : barGap
    const columnCount = Math.max(1, Math.floor(width / (targetBarWidth + targetGap)))
    const columns = computeColumnMetrics(columnCount, waveformData)
    if (!columns.length) {
      clearCanvases()
      return
    }

    const spacing = width / columns.length
    const gap = Math.min(targetGap, spacing * 0.25)
    let drawWidth = Math.min(targetBarWidth, spacing - gap)
    if (drawWidth <= 0) {
      drawWidth = spacing || 1
    }
    drawWidth = Math.max(0.2, Math.min(drawWidth, spacing))
    const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0

    const midY = height / 2
    const isHalf = useHalfWaveform()
    const baselineY = isHalf ? height : midY
    const scaleY = isHalf ? baselineY * 0.98 : midY * 0.96

    const baseGradient = baseCtx.createLinearGradient(0, 0, 0, height)
    baseGradient.addColorStop(0, '#cccccc')
    baseGradient.addColorStop(1, '#cccccc')

    const progressGradient = progressCtx.createLinearGradient(0, 0, 0, height)
    progressGradient.addColorStop(0, '#0078d4')
    progressGradient.addColorStop(1, '#0078d4')

    baseCtx.fillStyle = baseGradient
    progressCtx.fillStyle = progressGradient

    columns.forEach((column, index) => {
      const amplitudePx = Math.min(scaleY, Math.max(1, column.amplitude * scaleY))
      const rectHeight = Math.max(1, isHalf ? amplitudePx : amplitudePx * 2)
      const y = isHalf ? baselineY - rectHeight : midY - amplitudePx
      const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
      baseCtx.fillRect(x, y, drawWidth, rectHeight)
      progressCtx.fillRect(x, y, drawWidth, rectHeight)
    })
  }

  const drawRgbStyleWaveform = (
    width: number,
    height: number,
    waveformData: RGBWaveformData | null
  ) => {
    if (!waveformData) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const columns = computeColumnMetrics(Math.max(1, Math.floor(width)), waveformData)
    if (!columns.length) {
      clearCanvases()
      return
    }

    const isHalf = useHalfWaveform()
    const padding = Math.max(2, Math.floor(height * 0.08))
    const centerY = height / 2
    const baselineY = isHalf ? height - padding : centerY
    const maxAmplitude = isHalf ? height - padding * 1.05 : centerY - padding * 0.6

    const drawOnCtx = (ctx: CanvasRenderingContext2D, alpha: number) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.globalCompositeOperation = 'source-over'

      for (let x = 0; x < width; x++) {
        const column = columns[Math.min(columns.length - 1, x)]
        const amplitudePx = Math.min(maxAmplitude, Math.max(1, column.amplitude * maxAmplitude))
        const rectHeight = Math.max(1, isHalf ? amplitudePx : amplitudePx * 2)
        const yTop = isHalf ? baselineY - amplitudePx : centerY - amplitudePx
        const { r, g, b } = column.color
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
        ctx.fillRect(x, yTop, 1, rectHeight)
      }

      ctx.restore()
    }

    drawOnCtx(baseCtx, RGB_BASE_ALPHA)
    drawOnCtx(progressCtx, RGB_PROGRESS_ALPHA)
  }

  const drawWaveform = (forceRedraw = false) => {
    if (!waveformEl.value || !audioPlayer.value) return

    const container = waveformEl.value
    const width = container.clientWidth || 1
    const height = waveformHeight
    const player = audioPlayer.value

    const duration = audioBuffer?.duration ?? player?.getDuration?.() ?? 0
    const currentTime = player?.getCurrentTime?.() ?? 0
    const progress = duration > 0 ? currentTime / duration : 0
    updateProgressVisual(progress)

    if (!forceRedraw) {
      return
    }

    const waveformData = player.rgbWaveformData ?? null
    if (!waveformData) {
      clearCanvases()
      return
    }

    const style = getWaveformStyle()
    if (style === WAVEFORM_STYLE_SOUND_CLOUD || style === WAVEFORM_STYLE_FINE) {
      drawBarWaveform(width, height, style, waveformData)
    } else {
      drawRgbStyleWaveform(width, height, waveformData)
    }
  }

  let ro: ResizeObserver | null = null

  const updateWaveform = () => {
    if (!audioPlayer.value) return
    const player = audioPlayer.value
    const buffer = player.audioBuffer

    if (!buffer) {
      audioBuffer = null
      clearCanvases()
      updateProgressVisual(0)
      syncHoverOverlay(0)
      return
    }

    audioBuffer = buffer

    if (player.rgbWaveformData) {
      drawWaveform(true)
      return
    }

    clearCanvases()
    void player.ensureRgbWaveform().then(() => {
      if (audioPlayer.value === player && player.rgbWaveformData) {
        drawWaveform(true)
      }
    })
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

    const ensureRgbIfNeeded = () => {
      void player.ensureRgbWaveform()
    }

    const handleDecode = (duration: number) => {
      updateDurationDisplay(duration)
      updateProgressVisual(0)
      updateParentWaveformWidth()
      updateWaveform()
      ensureRgbIfNeeded()
      setTimeout(() => {
        updateParentWaveformWidth()
        updateWaveform()
        ensureRgbIfNeeded()
      }, 50)
    }

    const handleReady = () => {
      const playerDuration = audioPlayer.value?.getDuration?.()
      if (typeof playerDuration === 'number') {
        updateDurationDisplay(playerDuration)
      }
      updateProgressVisual(0)
      updateParentWaveformWidth()
      updateWaveform()
      ensureRgbIfNeeded()
      setTimeout(() => {
        updateParentWaveformWidth()
        updateWaveform()
        ensureRgbIfNeeded()
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
    registerPlayerHandler(player, 'rgbwaveformready', () => {
      drawWaveform(true)
    })
    ensureRgbIfNeeded()

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
    () => runtime.setting?.waveformStyle,
    () => {
      if (audioPlayer.value) {
        void audioPlayer.value.ensureRgbWaveform()
      }
      updateWaveform()
    }
  )

  watch(
    () => runtime.setting?.waveformMode,
    () => {
      updateWaveform()
    }
  )

  watch(
    () => audioPlayer.value,
    () => {
      detachEventListeners()
      attachEventListeners()
      updateProgressVisual(0)
      updateWaveform()
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
