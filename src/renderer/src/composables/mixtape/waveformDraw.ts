import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  MIXTAPE_WAVEFORM_HEIGHT_SCALE,
  MIXXX_RGB_COMPONENTS
} from '@renderer/composables/mixtape/constants'

const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

export const drawMixxxRgbWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveformData: MixxxWaveformData | null,
  isHalf: boolean,
  range?: {
    startFrame: number
    endFrame: number
    startTime: number
    endTime: number
    raw?: RawWaveformData | null
  }
) => {
  if (!waveformData) return
  if (width <= 0 || height <= 0) return

  const low = waveformData.bands.low
  const mid = waveformData.bands.mid
  const high = waveformData.bands.high
  const all = waveformData.bands.all
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
  if (!frameCount) return

  const rawStart = Number.isFinite(range?.startFrame) ? range!.startFrame : 0
  const rawEnd = Number.isFinite(range?.endFrame) ? range!.endFrame : frameCount
  const startFrame = Math.max(0, Math.min(frameCount - 1, Math.floor(rawStart)))
  const endFrame = Math.max(startFrame + 1, Math.min(frameCount, Math.ceil(rawEnd)))
  const visibleFrames = endFrame - startFrame
  if (visibleFrames <= 0) return

  const rawData = range?.raw || null
  const rawMinLeft = rawData?.minLeft || null
  const rawMaxLeft = rawData?.maxLeft || null
  const rawMinRight = rawData?.minRight || null
  const rawMaxRight = rawData?.maxRight || null
  const rawRate = Number(rawData?.rate || 0)
  const rawStartTime = Number(range?.startTime || 0)
  const rawEndTime = Number(range?.endTime || 0)
  const rawSpan = rawEndTime - rawStartTime
  const hasRaw =
    rawData &&
    rawMinLeft &&
    rawMaxLeft &&
    rawMinRight &&
    rawMaxRight &&
    rawRate > 0 &&
    Number.isFinite(rawSpan) &&
    rawSpan > 0

  const pixelRatio = window.devicePixelRatio || 1
  const length = Math.max(1, Math.floor(width * pixelRatio))
  const gain = (visibleFrames * 2) / length
  const offset = startFrame * 2
  const halfBreadth = height / 2
  const waveformHeightScale = Math.max(0.2, Math.min(1, MIXTAPE_WAVEFORM_HEIGHT_SCALE))
  const heightFactor = ((isHalf ? height : halfBreadth) * waveformHeightScale) / 255
  const rawHeightFactor = (isHalf ? height : halfBreadth) * waveformHeightScale
  const pixelWidth = 1 / pixelRatio
  ctx.globalCompositeOperation = 'source-over'
  ctx.imageSmoothingEnabled = false

  const columns = new Array<{
    r: number
    g: number
    b: number
    avgTop: number
    avgBottom: number
    peakTop: number
    peakBottom: number
  } | null>(length)

  const useInterpolatedSamples = gain <= 2
  const rawFrames = hasRaw
    ? Math.min(rawMinLeft.length, rawMaxLeft.length, rawMinRight.length, rawMaxRight.length)
    : 0
  const rawStartPos = hasRaw ? rawStartTime * rawRate : 0
  const rawEndPos = hasRaw ? rawEndTime * rawRate : 0
  const rawVisible = hasRaw ? Math.max(1, rawEndPos - rawStartPos) : 0
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t

  for (let x = 0; x < length; x += 1) {
    const xSampleWidth = gain * x
    const xVisualSampleIndex = xSampleWidth + offset
    const maxSamplingRange = gain / 2

    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllLeft = 0
    let maxAllRight = 0
    let maxAllAvgLeft = 0
    let maxAllAvgRight = 0

    if (useInterpolatedSamples) {
      const framePos = Math.max(startFrame, Math.min(endFrame - 1, xVisualSampleIndex / 2))
      const i0 = Math.floor(framePos)
      const i1 = Math.min(endFrame - 1, i0 + 1)
      const t = framePos - i0
      const lerp = (a: number, b: number) => a + (b - a) * t

      const lowLeft = lerp(low.left[i0], low.left[i1])
      const lowRight = lerp(low.right[i0], low.right[i1])
      const midLeft = lerp(mid.left[i0], mid.left[i1])
      const midRight = lerp(mid.right[i0], mid.right[i1])
      const highLeft = lerp(high.left[i0], high.left[i1])
      const highRight = lerp(high.right[i0], high.right[i1])
      const allAvgLeft = lerp(all.left[i0], all.left[i1])
      const allAvgRight = lerp(all.right[i0], all.right[i1])
      const peakLeft0 = all.peakLeft ? all.peakLeft[i0] : all.left[i0]
      const peakLeft1 = all.peakLeft ? all.peakLeft[i1] : all.left[i1]
      const peakRight0 = all.peakRight ? all.peakRight[i0] : all.right[i0]
      const peakRight1 = all.peakRight ? all.peakRight[i1] : all.right[i1]
      const allLeft = lerp(peakLeft0, peakLeft1)
      const allRight = lerp(peakRight0, peakRight1)

      maxLow = Math.max(lowLeft, lowRight)
      maxMid = Math.max(midLeft, midRight)
      maxHigh = Math.max(highLeft, highRight)
      maxAllLeft = allLeft
      maxAllRight = allRight
      maxAllAvgLeft = allAvgLeft
      maxAllAvgRight = allAvgRight
    } else {
      let frameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
      let frameEnd = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
      frameStart = Math.max(startFrame, Math.min(endFrame - 1, frameStart))
      frameEnd = Math.max(startFrame, Math.min(endFrame - 1, frameEnd))
      if (frameEnd < frameStart) {
        const temp = frameEnd
        frameEnd = frameStart
        frameStart = temp
      }
      for (let frameIndex = frameStart; frameIndex <= frameEnd; frameIndex += 1) {
        const lowLeft = low.left[frameIndex]
        const lowRight = low.right[frameIndex]
        const midLeft = mid.left[frameIndex]
        const midRight = mid.right[frameIndex]
        const highLeft = high.left[frameIndex]
        const highRight = high.right[frameIndex]
        const allAvgLeft = all.left[frameIndex]
        const allAvgRight = all.right[frameIndex]
        const allLeft = all.peakLeft ? all.peakLeft[frameIndex] : allAvgLeft
        const allRight = all.peakRight ? all.peakRight[frameIndex] : allAvgRight

        if (lowLeft > maxLow) maxLow = lowLeft
        if (lowRight > maxLow) maxLow = lowRight
        if (midLeft > maxMid) maxMid = midLeft
        if (midRight > maxMid) maxMid = midRight
        if (highLeft > maxHigh) maxHigh = highLeft
        if (highRight > maxHigh) maxHigh = highRight

        if (allLeft > maxAllLeft) maxAllLeft = allLeft
        if (allRight > maxAllRight) maxAllRight = allRight
        if (allAvgLeft > maxAllAvgLeft) maxAllAvgLeft = allAvgLeft
        if (allAvgRight > maxAllAvgRight) maxAllAvgRight = allAvgRight
      }
    }

    const allUnscaled = maxLow + maxMid + maxHigh
    let eqGain = 1
    if (allUnscaled > 0) {
      eqGain = (maxLow + maxMid + maxHigh) / allUnscaled
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
    if (maxColor <= 0) {
      columns[x] = null
      continue
    }

    let avgTop = heightFactor * eqGain * maxAllAvgLeft
    let avgBottom = heightFactor * eqGain * maxAllAvgRight
    let peakTop = heightFactor * eqGain * maxAllLeft
    let peakBottom = heightFactor * eqGain * maxAllRight

    if (hasRaw && rawMinLeft && rawMaxLeft && rawMinRight && rawMaxRight && rawFrames > 1) {
      const rawPos = rawStartPos + (x / Math.max(1, length - 1)) * rawVisible
      const rawIndex = Math.max(0, Math.min(rawFrames - 1, rawPos))
      const i0 = Math.floor(rawIndex)
      const i1 = Math.min(rawFrames - 1, i0 + 1)
      const t = rawIndex - i0
      const rawMinLeftValue = lerp(rawMinLeft[i0] || 0, rawMinLeft[i1] || 0, t)
      const rawMaxLeftValue = lerp(rawMaxLeft[i0] || 0, rawMaxLeft[i1] || 0, t)
      const rawMinRightValue = lerp(rawMinRight[i0] || 0, rawMinRight[i1] || 0, t)
      const rawMaxRightValue = lerp(rawMaxRight[i0] || 0, rawMaxRight[i1] || 0, t)
      const leftPeak = Math.max(Math.abs(rawMinLeftValue), Math.abs(rawMaxLeftValue))
      const rightPeak = Math.max(Math.abs(rawMinRightValue), Math.abs(rawMaxRightValue))
      avgTop = leftPeak * rawHeightFactor
      avgBottom = rightPeak * rawHeightFactor
      peakTop = avgTop
      peakBottom = avgBottom
    }

    const color = {
      r: toColorChannel((red / maxColor) * 255),
      g: toColorChannel((green / maxColor) * 255),
      b: toColorChannel((blue / maxColor) * 255),
      avgTop,
      avgBottom,
      peakTop,
      peakBottom
    }
    columns[x] = color
  }

  const drawBand = (alpha: number, usePeak: boolean) => {
    ctx.globalAlpha = alpha
    for (let x = 0; x < length - 1; x += 1) {
      const current = columns[x]
      const next = columns[x + 1]
      if (!current && !next) continue
      const color = current ?? next
      if (!color) continue
      const curTop = usePeak ? (current?.peakTop ?? 0) : (current?.avgTop ?? 0)
      const curBottom = usePeak ? (current?.peakBottom ?? 0) : (current?.avgBottom ?? 0)
      const nextTop = usePeak ? (next?.peakTop ?? curTop) : (next?.avgTop ?? curTop)
      const nextBottom = usePeak ? (next?.peakBottom ?? curBottom) : (next?.avgBottom ?? curBottom)
      const x0 = x * pixelWidth
      const x1 = (x + 1) * pixelWidth

      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`
      ctx.beginPath()
      if (isHalf) {
        const curAmp = Math.max(curTop, curBottom)
        const nextAmp = Math.max(nextTop, nextBottom)
        ctx.moveTo(x0, height)
        ctx.lineTo(x0, height - curAmp)
        ctx.lineTo(x1, height - nextAmp)
        ctx.lineTo(x1, height)
      } else {
        ctx.moveTo(x0, halfBreadth - curTop)
        ctx.lineTo(x1, halfBreadth - nextTop)
        ctx.lineTo(x1, halfBreadth + nextBottom)
        ctx.lineTo(x0, halfBreadth + curBottom)
      }
      ctx.closePath()
      ctx.fill()
    }
  }

  if (hasRaw) {
    drawBand(1, false)
  } else {
    drawBand(0.22, true)
    drawBand(0.9, false)
  }
  ctx.globalAlpha = 1
}
