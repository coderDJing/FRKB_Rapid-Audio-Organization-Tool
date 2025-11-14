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
  const barGap = 1
  const cursorWidth = 1
  const WAVEFORM_STYLE_SOUND_CLOUD: WaveformStyle = 'SoundCloud'
  const WAVEFORM_STYLE_FINE: WaveformStyle = 'Fine'
  const WAVEFORM_STYLE_RGB: WaveformStyle = 'RGB'
  const RGB_BASE_ALPHA = 0.42
  const RGB_PROGRESS_ALPHA = 0.95
  const REKORDBOX_RGB_COLORS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
    low: { r: 255, g: 80, b: 70 }, // 参考 Rekordbox 低频红
    mid: { r: 120, g: 255, b: 85 }, // 参考 Rekordbox 中频绿
    high: { r: 90, g: 190, b: 255 } // 参考 Rekordbox 高频蓝
  }
  const RGB_BAND_INTENSITY_EXP: Record<RGBWaveformBandKey, number> = {
    low: 0.9,
    mid: 0.82,
    high: 0.75
  }
  const RGB_BAND_AMPLITUDE_WEIGHT: Record<RGBWaveformBandKey, number> = {
    low: 0.9,
    mid: 1,
    high: 1.2
  }

  const drawFineWaveform = (width: number, height: number) => {
    if (!soundCloudMinMaxData || !audioBuffer) {
      clearCanvases()
      return
    }

    const totalBars = soundCloudMinMaxData.length
    if (!totalBars) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const spacing = width / totalBars
    const gap = Math.min(barGap, spacing * 0.25)
    let drawWidth = spacing - gap
    drawWidth = Math.min(barWidth, drawWidth)
    if (drawWidth <= 0) {
      drawWidth = spacing || 1
    }
    drawWidth = Math.max(0.2, Math.min(drawWidth, spacing))
    const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0

    const midY = height / 2
    const isHalf = useHalfWaveform()
    const baselineY = isHalf ? height : midY
    const scaleY = isHalf ? baselineY : midY

    const baseGradient = baseCtx.createLinearGradient(0, 0, 0, height)
    baseGradient.addColorStop(0, '#cccccc')
    baseGradient.addColorStop(1, '#cccccc')

    const progressGradient = progressCtx.createLinearGradient(0, 0, 0, height)
    progressGradient.addColorStop(0, '#0078d4')
    progressGradient.addColorStop(1, '#0078d4')

    baseCtx.fillStyle = baseGradient
    progressCtx.fillStyle = progressGradient

    for (let index = 0; index < totalBars; index++) {
      const { min, max } = soundCloudMinMaxData[index]
      const x = index * spacing + offset
      const clampedX = Math.max(0, Math.min(width - drawWidth, x))

      if (isHalf) {
        const amplitude = Math.max(Math.abs(min), Math.abs(max))
        const rectHeight = Math.max(1, amplitude * scaleY)
        const y = baselineY - rectHeight
        baseCtx.fillRect(clampedX, y, drawWidth, rectHeight)
        progressCtx.fillRect(clampedX, y, drawWidth, rectHeight)
      } else {
        const barMin = midY + min * midY
        const barMax = midY + max * midY
        const rectHeight = Math.max(1, barMax - barMin)
        baseCtx.fillRect(clampedX, barMin, drawWidth, rectHeight)
        progressCtx.fillRect(clampedX, barMin, drawWidth, rectHeight)
      }
    }
  }

  const getWaveformStyle = (): WaveformStyle => {
    const style = runtime.setting?.waveformStyle
    return (
      style === WAVEFORM_STYLE_RGB ||
      style === WAVEFORM_STYLE_FINE ||
      style === WAVEFORM_STYLE_SOUND_CLOUD
        ? style
        : WAVEFORM_STYLE_SOUND_CLOUD
    ) as WaveformStyle
  }

  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'

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
  let soundCloudMinMaxData: Array<{ min: number; max: number }> | null = null
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

  const drawSoundCloudWaveform = (width: number, height: number) => {
    if (!soundCloudMinMaxData || !audioBuffer) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const totalBars = Math.max(1, Math.floor(width / (barWidth + barGap)))
    const sampleStep = soundCloudMinMaxData.length / totalBars
    const maxSamplesPerBar = 24
    const isHalf = useHalfWaveform()
    const midY = height / 2
    const baseGradient = baseCtx.createLinearGradient(0, 0, 0, height)
    baseGradient.addColorStop(0, '#cccccc')
    baseGradient.addColorStop(1, '#cccccc')

    const progressGradient = progressCtx.createLinearGradient(0, 0, 0, height)
    progressGradient.addColorStop(0, '#0078d4')
    progressGradient.addColorStop(1, '#0078d4')

    const baselineY = isHalf ? height : midY
    const scaleY = isHalf ? baselineY : midY

    const bars: Array<{ x: number; y: number; rectHeight: number }> = []

    for (let barIndex = 0; barIndex < totalBars; barIndex++) {
      let start = Math.floor(barIndex * sampleStep)
      let end = Math.floor((barIndex + 1) * sampleStep)
      if (barIndex === totalBars - 1) {
        end = soundCloudMinMaxData.length
      }
      if (end <= start) {
        end = Math.min(soundCloudMinMaxData.length, start + 1)
      }
      if (end - start > maxSamplesPerBar) {
        start = Math.max(0, end - maxSamplesPerBar)
      }
      if (start >= end) continue

      let min = 1
      let max = -1
      for (let i = start; i < end; i++) {
        const { min: currentMin, max: currentMax } = soundCloudMinMaxData[i]
        if (currentMin < min) min = currentMin
        if (currentMax > max) max = currentMax
      }

      const x = barIndex * (barWidth + barGap)

      if (isHalf) {
        const amplitude = Math.max(Math.abs(min), Math.abs(max))
        const rectHeight = Math.max(1, amplitude * scaleY)
        const y = baselineY - rectHeight
        bars.push({ x, y, rectHeight })
      } else {
        const barMin = midY + min * midY
        const barMax = midY + max * midY
        const rectHeight = Math.max(1, barMax - barMin)
        bars.push({ x, y: barMin, rectHeight })
      }
    }

    baseCtx.fillStyle = baseGradient
    for (const { x, y, rectHeight } of bars) {
      baseCtx.fillRect(x, y, barWidth, rectHeight)
    }

    progressCtx.fillStyle = progressGradient
    for (const { x, y, rectHeight } of bars) {
      progressCtx.fillRect(x, y, barWidth, rectHeight)
    }
  }

  const drawRgbWaveform = (width: number, height: number, waveformData: RGBWaveformData | null) => {
    if (!waveformData) {
      clearCanvases()
      return
    }

    const lowLen = waveformData.bands.low?.values.length ?? 0
    const midLen = waveformData.bands.mid?.values.length ?? 0
    const highLen = waveformData.bands.high?.values.length ?? 0
    const totalPoints = Math.min(lowLen, midLen, highLen)
    if (totalPoints === 0) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const centerY = height / 2
    const isHalf = useHalfWaveform()
    const baselineY = isHalf ? height : centerY
    const baseAmplitude = isHalf ? height * 0.95 : centerY * 0.92
    const spacing = totalPoints > 0 ? width / totalPoints : width
    const gap = Math.min(barGap, spacing * 0.25)
    let drawWidth = spacing - gap
    drawWidth = Math.min(barWidth, drawWidth)
    if (drawWidth <= 0) {
      drawWidth = spacing || 1
    }
    drawWidth = Math.max(0.2, Math.min(drawWidth, spacing))
    const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0

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

    const drawOnCtx = (ctx: CanvasRenderingContext2D, alpha: number) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.globalCompositeOperation = 'source-over'

      for (let i = 0; i < totalPoints; i++) {
        const x = i * spacing + offset

        const lowIntensity = getBandIntensity('low', i)
        const midIntensity = getBandIntensity('mid', i)
        const highIntensity = getBandIntensity('high', i)

        const weightedEnergy =
          lowIntensity * RGB_BAND_AMPLITUDE_WEIGHT.low +
          midIntensity * RGB_BAND_AMPLITUDE_WEIGHT.mid +
          highIntensity * RGB_BAND_AMPLITUDE_WEIGHT.high
        if (weightedEnergy <= 0.0001) continue

        const amplitudeRatio = Math.min(1, Math.pow(weightedEnergy, 0.6))
        const amplitudePx = amplitudeRatio * baseAmplitude
        const yTop = baselineY - amplitudePx
        const height = Math.max(1, isHalf ? amplitudePx : amplitudePx * 2)

        const sumIntensity = lowIntensity + midIntensity + highIntensity
        const mixDivider = sumIntensity > 0 ? sumIntensity : 1
        const baseR =
          (REKORDBOX_RGB_COLORS.low.r * lowIntensity +
            REKORDBOX_RGB_COLORS.mid.r * midIntensity +
            REKORDBOX_RGB_COLORS.high.r * highIntensity) /
          mixDivider
        const baseG =
          (REKORDBOX_RGB_COLORS.low.g * lowIntensity +
            REKORDBOX_RGB_COLORS.mid.g * midIntensity +
            REKORDBOX_RGB_COLORS.high.g * highIntensity) /
          mixDivider
        const baseB =
          (REKORDBOX_RGB_COLORS.low.b * lowIntensity +
            REKORDBOX_RGB_COLORS.mid.b * midIntensity +
            REKORDBOX_RGB_COLORS.high.b * highIntensity) /
          mixDivider

        const brightness = Math.min(1, Math.pow(amplitudeRatio, 0.75) * 1.15)
        const r = Math.min(255, Math.round(baseR * 0.6 + baseR * brightness * 0.4))
        const g = Math.min(255, Math.round(baseG * 0.6 + baseG * brightness * 0.4))
        const b = Math.min(255, Math.round(baseB * 0.6 + baseB * brightness * 0.4))

        const xPos = Math.max(0, Math.min(width - drawWidth, x))
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
        const drawY = isHalf ? yTop : centerY - amplitudePx
        ctx.fillRect(xPos, drawY, drawWidth, height)
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

    const style = getWaveformStyle()
    if (style === WAVEFORM_STYLE_SOUND_CLOUD) {
      drawSoundCloudWaveform(width, height)
    } else if (style === WAVEFORM_STYLE_FINE) {
      drawFineWaveform(width, height)
    } else {
      drawRgbWaveform(width, height, player.rgbWaveformData ?? null)
    }
  }

  let ro: ResizeObserver | null = null

  const updateWaveform = () => {
    if (!audioPlayer.value) return
    const player = audioPlayer.value
    const style = getWaveformStyle()
    const buffer = player.audioBuffer

    if (!buffer) {
      soundCloudMinMaxData = null
      audioBuffer = null
      clearCanvases()
      updateProgressVisual(0)
      syncHoverOverlay(0)
      return
    }

    audioBuffer = buffer

    if (style === WAVEFORM_STYLE_RGB) {
      soundCloudMinMaxData = null
      if (player.rgbWaveformData) {
        drawWaveform(true)
      } else {
        void player.ensureRgbWaveform().then(() => {
          if (getWaveformStyle() === WAVEFORM_STYLE_RGB) {
            drawWaveform(true)
          }
        })
      }
      return
    }

    const channelData = buffer.getChannelData(0)
    const samples = channelData.length
    const downsampleFactor = Math.max(1, Math.floor(samples / 2000))

    const length = Math.min(5000, Math.floor(samples / downsampleFactor))
    soundCloudMinMaxData = new Array(length)
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
      soundCloudMinMaxData[i] = { min, max }
    }

    void player.ensureRgbWaveform()
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

    const ensureRgbIfNeeded = () => {
      if (getWaveformStyle() === WAVEFORM_STYLE_RGB) {
        void player.ensureRgbWaveform()
      }
    }

    const handleDecode = (duration: number) => {
      updateDurationDisplay(duration)
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
      if (getWaveformStyle() === WAVEFORM_STYLE_RGB) {
        drawWaveform(true)
      }
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
      if (audioPlayer.value && getWaveformStyle() === WAVEFORM_STYLE_RGB) {
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
