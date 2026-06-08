import { onMounted, onUnmounted, watch, type Ref } from 'vue'
import {
  WebAudioPlayer,
  type SeekedEventPayload,
  type WaveformStyle,
  type WebAudioPlayerEvents
} from './webAudioPlayer'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { drawBufferedRawWaveform } from './waveformRawRenderer'
import { drawPlayerCompactVisualWaveform } from './playerCompactVisualWaveformRenderer'

export function useWaveform(params: {
  waveformEl: Ref<HTMLDivElement | null>
  audioPlayer: Ref<WebAudioPlayer | null>
  rawWaveformData: Ref<RawWaveformData | null>
  runtime: ReturnType<typeof useRuntimeStore>
  updateParentWaveformWidth: () => void
  onNextSong: () => void
  playerControlsRef?: { value?: { setPlayingValue?: (v: boolean) => void } | null }
  onError?: (error: unknown) => void
}) {
  const {
    waveformEl,
    audioPlayer,
    rawWaveformData,
    runtime,
    updateParentWaveformWidth,
    onNextSong,
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
    return WAVEFORM_STYLE_RGB
  }

  type MinMaxSample = {
    min: number
    max: number
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

  const canvasContainer = document.createElement('div')
  canvasContainer.style.position = 'relative'
  canvasContainer.style.width = '100%'
  canvasContainer.style.height = `${waveformHeight}px`
  canvasContainer.style.pointerEvents = 'auto'
  canvasContainer.style.background = 'var(--waveform-bg)'
  canvasContainer.style.overflow = 'hidden'

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
  let hoverEl: HTMLElement | null = null
  let isPointerDown = false
  type AudioEventName = keyof WebAudioPlayerEvents
  const audioEventHandlers: Array<() => void> = []

  const registerPlayerHandler = <K extends AudioEventName>(
    player: WebAudioPlayer,
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ) => {
    player.on(event, handler)
    audioEventHandlers.push(() => {
      player.off(event, handler)
    })
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

  const drawPioneerPreviewWaveform = (
    width: number,
    height: number,
    waveformData: IPioneerPreviewWaveformData,
    progressColor: string,
    tintProgress = false
  ) => {
    const columns = Array.isArray(waveformData?.columns) ? waveformData.columns : []
    const maxHeight = Math.max(
      1,
      Number(waveformData?.maxHeight) ||
        columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
    )
    if (!columns.length || width <= 0 || height <= 0 || maxHeight <= 0) {
      clearCanvases()
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

    const drawToCanvas = (ctx: CanvasRenderingContext2D, applyTint: boolean) => {
      const columnCount = Math.max(1, Math.floor(width))
      const samplesPerColumn = columns.length / columnCount
      const spacing = width / columnCount
      const drawWidth = Math.max(1, spacing)
      const scaleY = height / maxHeight

      for (let index = 0; index < columnCount; index++) {
        const start = Math.floor(index * samplesPerColumn)
        const end = Math.min(
          columns.length,
          Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
        )
        let selected = columns[start] || null
        for (let i = start; i < end; i++) {
          const candidate = columns[i]
          if (!candidate) continue
          if (!selected || (candidate.backHeight || 0) >= (selected.backHeight || 0)) {
            selected = candidate
          }
        }
        if (!selected) continue

        const backHeight = Math.max(0, Number(selected.backHeight) || 0)
        const frontHeight = Math.max(0, Number(selected.frontHeight) || 0)
        const x = Math.min(width - drawWidth, index * spacing)

        if (backHeight > 0) {
          const backPixelHeight = Math.max(1, backHeight * scaleY)
          ctx.fillStyle = `rgb(${selected.backColorR || 0}, ${selected.backColorG || 0}, ${selected.backColorB || 0})`
          ctx.fillRect(x, height - backPixelHeight, drawWidth, backPixelHeight)
        }

        if (frontHeight > 0) {
          const frontPixelHeight = Math.max(1, frontHeight * scaleY)
          ctx.fillStyle = `rgb(${selected.frontColorR || 0}, ${selected.frontColorG || 0}, ${selected.frontColorB || 0})`
          ctx.fillRect(x, height - frontPixelHeight, drawWidth, frontPixelHeight)
        }
      }

      if (!applyTint) return
      ctx.save()
      ctx.globalCompositeOperation = 'source-atop'
      ctx.globalAlpha = 0.32
      ctx.fillStyle = progressColor
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
    }

    drawToCanvas(baseCtx, false)
    drawToCanvas(progressCtx, tintProgress)
  }

  const drawWaveform = (forceRedraw = false) => {
    if (!waveformEl.value || !audioPlayer.value) return

    const container = waveformEl.value
    const width = container.clientWidth || 1
    const height = waveformHeight
    const player = audioPlayer.value
    const pioneerPreviewData = player.pioneerPreviewWaveformData ?? null
    const compactVisualData = player.compactVisualWaveformData ?? null
    const rawData = rawWaveformData.value

    const duration = player?.getDuration?.() ?? audioBuffer?.duration ?? rawData?.duration ?? 0
    const currentTime = player?.getCurrentTime?.() ?? 0
    const progress = duration > 0 ? currentTime / duration : 0
    updateProgressVisual(progress)

    if (!forceRedraw) {
      return
    }

    if (pioneerPreviewData) {
      drawPioneerPreviewWaveform(width, height, pioneerPreviewData, '#0078d4', true)
      return
    }

    if (compactVisualData) {
      drawPlayerCompactVisualWaveform({
        width,
        height,
        data: compactVisualData,
        useHalfWaveform: useHalfWaveform(),
        baseCanvas,
        progressCanvas,
        baseCtx,
        progressCtx,
        pixelRatio: window.devicePixelRatio || 1,
        resizeCanvas
      })
      return
    }

    const style = getWaveformStyle()
    if (style === WAVEFORM_STYLE_FINE) {
      if (rawData) {
        drawBufferedRawWaveform({
          waveformData: rawData,
          width,
          height,
          style,
          useHalfWaveform: useHalfWaveform(),
          baseCanvas,
          progressCanvas,
          baseCtx,
          progressCtx,
          pixelRatio: window.devicePixelRatio || 1,
          barWidth,
          barGap,
          resizeCanvas
        })
        return
      }
      drawFineWaveform(width, height)
      return
    }

    if (style === WAVEFORM_STYLE_RGB) {
      if (rawData) {
        drawBufferedRawWaveform({
          waveformData: rawData,
          width,
          height,
          style,
          useHalfWaveform: useHalfWaveform(),
          baseCanvas,
          progressCanvas,
          baseCtx,
          progressCtx,
          pixelRatio: window.devicePixelRatio || 1,
          barWidth,
          barGap,
          resizeCanvas
        })
        return
      }
      clearCanvases()
      return
    }

    if (rawData) {
      drawBufferedRawWaveform({
        waveformData: rawData,
        width,
        height,
        style,
        useHalfWaveform: useHalfWaveform(),
        baseCanvas,
        progressCanvas,
        baseCtx,
        progressCtx,
        pixelRatio: window.devicePixelRatio || 1,
        barWidth,
        barGap,
        resizeCanvas
      })
      return
    }

    drawSoundCloudWaveform(width, height)
  }

  let ro: ResizeObserver | null = null

  const updateWaveform = () => {
    if (!audioPlayer.value) return
    const player = audioPlayer.value
    const pioneerPreviewData = player.pioneerPreviewWaveformData ?? null
    const compactVisualData = player.compactVisualWaveformData ?? null
    const rawData = rawWaveformData.value
    if (!pioneerPreviewData && !compactVisualData && !rawData) {
      audioBuffer = null
      soundCloudMinMaxData = null
      clearCanvases()
      updateProgressVisual(0)
      syncHoverOverlay(0)
      return
    }

    if (pioneerPreviewData) {
      audioBuffer = null
      soundCloudMinMaxData = null
      drawWaveform(true)
      return
    }

    const buffer = player.audioBuffer ?? null
    audioBuffer = buffer
    soundCloudMinMaxData = null
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
      runtime.playerReady = true
      runtime.isSwitchingSong = false
    }

    const handlePause = () => {
      playerControlsRef?.value?.setPlayingValue?.(false)
      drawWaveform()
    }

    const handleTimeUpdate = (currentTime: number) => {
      drawWaveform()
      updateTimeDisplay(currentTime)
    }

    const handleFinish = () => {
      if (runtime.setting.autoPlayNextSong) {
        onNextSong()
      }
      drawWaveform()
    }

    registerPlayerHandler(player, 'decode', handleDecode)
    registerPlayerHandler(player, 'ready', handleReady)
    const handleSeeked = (payload: SeekedEventPayload) => {
      drawWaveform()
      updateTimeDisplay(payload.time)
    }

    registerPlayerHandler(player, 'play', handlePlay)
    registerPlayerHandler(player, 'pause', handlePause)
    registerPlayerHandler(player, 'timeupdate', handleTimeUpdate)
    registerPlayerHandler(player, 'seeked', handleSeeked)
    registerPlayerHandler(player, 'finish', handleFinish)
    registerPlayerHandler(player, 'waveformready', () => {
      updateWaveform()
    })

    if (onError) {
      const handleError = (error: unknown) => {
        onError(error)
      }
      registerPlayerHandler(player, 'error', handleError)
    }
  }

  const detachEventListeners = () => {
    if (audioEventHandlers.length) {
      for (const dispose of audioEventHandlers) {
        try {
          dispose()
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
    () => rawWaveformData.value,
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
