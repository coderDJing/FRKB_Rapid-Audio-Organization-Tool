import { onMounted, onUnmounted, watch, type Ref } from 'vue'
import {
  WebAudioPlayer,
  type RGBWaveformBandKey,
  type MixxxWaveformData,
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
  const MIXXX_BASE_ALPHA = 1
  const MIXXX_PROGRESS_ALPHA = 1
  const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
  const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
  const MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE = 0.4
  const MIXXX_RGB_COMPONENTS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
    low: { r: 1, g: 0, b: 0 },
    mid: { r: 0, g: 1, b: 0 },
    high: { r: 0, g: 0, b: 1 }
  }
  const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
  const normalizeWaveformStyle = (
    style?: WaveformStyle | 'RekordboxMini' | 'Mixxx'
  ): WaveformStyle => {
    if (style === 'RekordboxMini' || style === 'Mixxx') return WAVEFORM_STYLE_RGB
    if (
      style === WAVEFORM_STYLE_RGB ||
      style === WAVEFORM_STYLE_FINE ||
      style === WAVEFORM_STYLE_SOUND_CLOUD
    ) {
      return style
    }
    return WAVEFORM_STYLE_SOUND_CLOUD
  }

  type MinMaxSample = {
    min: number
    max: number
  }

  type MixxxColumnMetrics = {
    amplitudeLeft: number
    amplitudeRight: number
    color: { r: number; g: number; b: number }
    progressColor: { r: number; g: number; b: number }
  }

  const getWaveformStyle = (): WaveformStyle => {
    return normalizeWaveformStyle(runtime.setting?.waveformStyle)
  }

  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'

  const drawFineWaveform = (width: number, height: number) => {
    if (!soundCloudMinMaxData) {
      clearCanvases()
      return
    }

    const totalBars = soundCloudMinMaxData.length
    if (!totalBars) {
      clearCanvases()
      return
    }

    if (!baseCtx || !progressCtx) throw new Error('canvas context is null')

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

  const buildMinMaxDataFromMixxx = (waveformData: MixxxWaveformData): MinMaxSample[] => {
    const low = waveformData.bands.low
    const mid = waveformData.bands.mid
    const high = waveformData.bands.high
    const frameCount = Math.min(
      low.left.length,
      low.right.length,
      mid.left.length,
      mid.right.length,
      high.left.length,
      high.right.length
    )
    if (!frameCount) return []

    const data = new Array<MinMaxSample>(frameCount)

    for (let i = 0; i < frameCount; i++) {
      const lowLeft = low.peakLeft ? low.peakLeft[i] : low.left[i]
      const lowRight = low.peakRight ? low.peakRight[i] : low.right[i]
      const midLeft = mid.peakLeft ? mid.peakLeft[i] : mid.left[i]
      const midRight = mid.peakRight ? mid.peakRight[i] : mid.right[i]
      const highLeft = high.peakLeft ? high.peakLeft[i] : high.left[i]
      const highRight = high.peakRight ? high.peakRight[i] : high.right[i]

      const leftEnergy = Math.sqrt(lowLeft * lowLeft + midLeft * midLeft + highLeft * highLeft)
      const rightEnergy = Math.sqrt(
        lowRight * lowRight + midRight * midRight + highRight * highRight
      )

      const leftAmplitude = Math.min(1, leftEnergy / MIXXX_MAX_RGB_ENERGY)
      const rightAmplitude = Math.min(1, rightEnergy / MIXXX_MAX_RGB_ENERGY)

      data[i] = {
        min: -rightAmplitude,
        max: leftAmplitude
      }
    }

    return data
  }

  const computeMixxxColumnMetrics = (
    columnCount: number,
    waveformData: MixxxWaveformData | null
  ): MixxxColumnMetrics[] => {
    if (!waveformData || columnCount <= 0) return []

    const low = waveformData.bands.low
    const mid = waveformData.bands.mid
    const high = waveformData.bands.high
    const frameCount = Math.min(
      low.left.length,
      low.right.length,
      mid.left.length,
      mid.right.length,
      high.left.length,
      high.right.length
    )
    if (frameCount === 0) return []

    const columns: MixxxColumnMetrics[] = new Array(columnCount)
    const dataSize = frameCount * 2
    const gain = dataSize / Math.max(1, columnCount)
    const lastVisualFrame = frameCount - 1

    for (let x = 0; x < columnCount; x++) {
      const xSampleWidth = gain * x
      const xVisualSampleIndex = xSampleWidth
      const maxSamplingRange = gain / 2

      let visualFrameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
      let visualFrameStop = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
      if (visualFrameStart < 0) visualFrameStart = 0
      if (visualFrameStop > lastVisualFrame) visualFrameStop = lastVisualFrame
      if (visualFrameStop < visualFrameStart) {
        visualFrameStop = visualFrameStart
      }

      let maxLow = 0
      let maxMid = 0
      let maxHigh = 0
      let maxAllLeft = 0
      let maxAllRight = 0

      for (let i = visualFrameStart; i <= visualFrameStop; i++) {
        const lowLeft = low.left[i]
        const lowRight = low.right[i]
        const midLeft = mid.left[i]
        const midRight = mid.right[i]
        const highLeft = high.left[i]
        const highRight = high.right[i]
        const lowLeftAmp = low.peakLeft ? low.peakLeft[i] : lowLeft
        const lowRightAmp = low.peakRight ? low.peakRight[i] : lowRight
        const midLeftAmp = mid.peakLeft ? mid.peakLeft[i] : midLeft
        const midRightAmp = mid.peakRight ? mid.peakRight[i] : midRight
        const highLeftAmp = high.peakLeft ? high.peakLeft[i] : highLeft
        const highRightAmp = high.peakRight ? high.peakRight[i] : highRight

        if (lowLeft > maxLow) maxLow = lowLeft
        if (lowRight > maxLow) maxLow = lowRight
        if (midLeft > maxMid) maxMid = midLeft
        if (midRight > maxMid) maxMid = midRight
        if (highLeft > maxHigh) maxHigh = highLeft
        if (highRight > maxHigh) maxHigh = highRight

        const allLeft =
          lowLeftAmp * lowLeftAmp + midLeftAmp * midLeftAmp + highLeftAmp * highLeftAmp
        const allRight =
          lowRightAmp * lowRightAmp + midRightAmp * midRightAmp + highRightAmp * highRightAmp
        if (allLeft > maxAllLeft) maxAllLeft = allLeft
        if (allRight > maxAllRight) maxAllRight = allRight
      }

      const red =
        maxLow * MIXXX_RGB_COMPONENTS.low.r +
        maxMid * MIXXX_RGB_COMPONENTS.mid.r +
        maxHigh * MIXXX_RGB_COMPONENTS.high.r
      const green =
        maxLow * MIXXX_RGB_COMPONENTS.low.g +
        maxMid * MIXXX_RGB_COMPONENTS.mid.g +
        maxHigh * MIXXX_RGB_COMPONENTS.high.g
      const blue =
        maxLow * MIXXX_RGB_COMPONENTS.low.b +
        maxMid * MIXXX_RGB_COMPONENTS.mid.b +
        maxHigh * MIXXX_RGB_COMPONENTS.high.b

      const maxColor = Math.max(red, green, blue)
      const color =
        maxColor > 0
          ? {
              r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
              g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
              b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
            }
          : { r: 0, g: 0, b: 0 }
      const progressColor =
        maxColor > 0
          ? {
              r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
              g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
              b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE)
            }
          : { r: 0, g: 0, b: 0 }

      const amplitudeLeft = Math.min(1, Math.sqrt(maxAllLeft) / MIXXX_MAX_RGB_ENERGY)
      const amplitudeRight = Math.min(1, Math.sqrt(maxAllRight) / MIXXX_MAX_RGB_ENERGY)

      columns[x] = {
        amplitudeLeft,
        amplitudeRight,
        color,
        progressColor
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
  let soundCloudMinMaxData: MinMaxSample[] | null = null
  let mixxxMinMaxSource: MixxxWaveformData | null = null
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
    if (!soundCloudMinMaxData) {
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

    const targetBarWidth = barWidth
    const targetGap = barGap
    const columnCount = Math.max(1, Math.floor(width / (targetBarWidth + targetGap)))
    const samplesPerColumn = totalBars / columnCount

    const spacing = width / columnCount
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

    for (let index = 0; index < columnCount; index++) {
      const start = Math.floor(index * samplesPerColumn)
      const end = Math.min(
        totalBars,
        Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
      )
      let peak = 0
      let sum = 0
      let count = 0

      for (let i = start; i < end; i++) {
        const { min, max } = soundCloudMinMaxData[i]
        const amplitude = Math.max(Math.abs(min), Math.abs(max))
        if (amplitude > peak) peak = amplitude
        sum += amplitude
        count++
      }

      const average = count ? sum / count : 0
      let amplitude = peak * 0.7 + average * 0.3
      amplitude = Math.max(0, Math.min(1, amplitude))
      const amplitudePx = Math.min(scaleY, Math.max(1, amplitude * scaleY))
      const rectHeight = Math.max(1, isHalf ? amplitudePx : amplitudePx * 2)
      const y = isHalf ? baselineY - rectHeight : midY - amplitudePx
      const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
      baseCtx.fillRect(x, y, drawWidth, rectHeight)
      progressCtx.fillRect(x, y, drawWidth, rectHeight)
    }
  }

  const drawMixxxWaveform = (
    width: number,
    height: number,
    waveformData: MixxxWaveformData | null
  ) => {
    if (!waveformData) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const columns = computeMixxxColumnMetrics(Math.max(1, Math.floor(width)), waveformData)
    if (!columns.length) {
      clearCanvases()
      return
    }

    const isHalf = useHalfWaveform()
    const centerY = height / 2
    const maxAmplitude = isHalf ? height : centerY

    const drawOnCtx = (ctx: CanvasRenderingContext2D, alpha: number, useProgressColor: boolean) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.globalCompositeOperation = 'source-over'

      for (let x = 0; x < columns.length; x++) {
        const column = columns[x]
        const { r, g, b } = useProgressColor ? column.progressColor : column.color
        if (!r && !g && !b) continue

        const amplitudeTop = Math.max(1, column.amplitudeLeft * maxAmplitude)
        const amplitudeBottom = Math.max(1, column.amplitudeRight * maxAmplitude)
        const rectHeight = isHalf
          ? Math.max(amplitudeTop, amplitudeBottom)
          : amplitudeTop + amplitudeBottom
        const yTop = isHalf ? height - rectHeight : centerY - amplitudeTop

        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
        ctx.fillRect(x, yTop, 1, rectHeight)
      }

      ctx.restore()
    }

    drawOnCtx(baseCtx, MIXXX_BASE_ALPHA, false)
    drawOnCtx(progressCtx, MIXXX_PROGRESS_ALPHA, true)
  }

  const drawWaveform = (forceRedraw = false) => {
    if (!waveformEl.value || !audioPlayer.value) return

    const container = waveformEl.value
    const width = container.clientWidth || 1
    const height = waveformHeight
    const player = audioPlayer.value

    const duration = player?.getDuration?.() ?? audioBuffer?.duration ?? 0
    const currentTime = player?.getCurrentTime?.() ?? 0
    const progress = duration > 0 ? currentTime / duration : 0
    updateProgressVisual(progress)

    if (!forceRedraw) {
      return
    }

    const style = getWaveformStyle()
    if (style === WAVEFORM_STYLE_FINE) {
      drawFineWaveform(width, height)
      return
    }

    if (style === WAVEFORM_STYLE_RGB) {
      const mixxxData = player.mixxxWaveformData ?? null
      if (!mixxxData) {
        clearCanvases()
        return
      }
      drawMixxxWaveform(width, height, mixxxData)
      return
    }

    drawSoundCloudWaveform(width, height)
  }

  let ro: ResizeObserver | null = null

  const updateWaveform = () => {
    if (!audioPlayer.value) return
    const player = audioPlayer.value
    const style = getWaveformStyle()
    const mixxxData = player.mixxxWaveformData ?? null
    if (!mixxxData) {
      audioBuffer = null
      soundCloudMinMaxData = null
      mixxxMinMaxSource = null
      clearCanvases()
      updateProgressVisual(0)
      syncHoverOverlay(0)
      return
    }

    const buffer = player.audioBuffer ?? null
    audioBuffer = buffer

    if (style !== WAVEFORM_STYLE_RGB) {
      if (!soundCloudMinMaxData || mixxxMinMaxSource !== mixxxData) {
        soundCloudMinMaxData = buildMinMaxDataFromMixxx(mixxxData)
        mixxxMinMaxSource = mixxxData
      }
    }

    if (style === WAVEFORM_STYLE_RGB) {
      drawWaveform(true)
      return
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
      updateProgressVisual(0)
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
      updateProgressVisual(0)
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
      if (runtime.setting.autoPlayNextSong) {
        onNextSong()
      }
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
    registerPlayerHandler(player, 'mixxxwaveformready', () => {
      updateWaveform()
    })

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
