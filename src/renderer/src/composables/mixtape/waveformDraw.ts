import type {
  RawWaveformData,
  MixtapeWaveformStemId,
  StemWaveformData
} from '@renderer/composables/mixtape/types'
import { MIXTAPE_WAVEFORM_HEIGHT_SCALE } from '@renderer/composables/mixtape/constants'

type StemWaveformColor = { r: number; g: number; b: number }

const STEM_WAVEFORM_COLORS: Record<MixtapeWaveformStemId, StemWaveformColor> = {
  vocal: { r: 59, g: 130, b: 246 },
  inst: { r: 20, g: 184, b: 166 },
  bass: { r: 168, g: 85, b: 247 },
  drums: { r: 249, g: 115, b: 22 }
}

const STEM_WAVEFORM_MAIN_ALPHA = 0.96
const STEM_WAVEFORM_RAW_ALPHA = 1

const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

export const resolveStemWaveformColor = (stemId?: MixtapeWaveformStemId): StemWaveformColor => {
  if (!stemId) return STEM_WAVEFORM_COLORS.inst
  return STEM_WAVEFORM_COLORS[stemId] || STEM_WAVEFORM_COLORS.inst
}

export const drawStemWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveformData: StemWaveformData | null,
  isHalf: boolean,
  range?: {
    startFrame: number
    endFrame: number
    startTime: number
    endTime: number
    raw?: RawWaveformData | null
    stemId?: MixtapeWaveformStemId
  }
) => {
  if (width <= 0 || height <= 0) return

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

  const all = waveformData?.all || null
  const peakLeft = all ? all.peakLeft || all.left : null
  const peakRight = all ? all.peakRight || all.right : null
  const frameCount = all
    ? Math.min(all.left.length, all.right.length, peakLeft?.length || 0, peakRight?.length || 0)
    : 1
  if (!hasRaw && (!all || !peakLeft || !peakRight || frameCount <= 0)) return

  const rawStart = Number.isFinite(range?.startFrame) ? range!.startFrame : 0
  const rawEnd = Number.isFinite(range?.endFrame) ? range!.endFrame : frameCount
  const startFrame = Math.max(0, Math.min(frameCount - 1, Math.floor(rawStart)))
  const endFrame = Math.max(startFrame + 1, Math.min(frameCount, Math.ceil(rawEnd)))
  const visibleFrames = endFrame - startFrame
  if (visibleFrames <= 0) return

  const pixelRatio = window.devicePixelRatio || 1
  const length = Math.max(1, Math.floor(width * pixelRatio))
  const halfBreadth = height / 2
  const waveformHeightScale = Math.max(0.2, Math.min(1, MIXTAPE_WAVEFORM_HEIGHT_SCALE))
  const heightFactor = ((isHalf ? height : halfBreadth) * waveformHeightScale) / 255
  const rawHeightFactor = (isHalf ? height : halfBreadth) * waveformHeightScale
  const pixelWidth = 1 / pixelRatio
  const stemColor = resolveStemWaveformColor(range?.stemId)
  ctx.globalCompositeOperation = 'source-over'
  ctx.imageSmoothingEnabled = false

  const amplitudes = new Float32Array(length)
  const gain = (visibleFrames * 2) / length
  const offset = startFrame * 2
  const useInterpolatedSamples = gain <= 2
  const rawFrames = hasRaw
    ? Math.min(rawMinLeft.length, rawMaxLeft.length, rawMinRight.length, rawMaxRight.length)
    : 0
  const rawStartPos = hasRaw ? rawStartTime * rawRate : 0
  const rawEndPos = hasRaw ? rawEndTime * rawRate : 0
  const rawVisible = hasRaw ? Math.max(1, rawEndPos - rawStartPos) : 0
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t

  if (hasRaw && rawMinLeft && rawMaxLeft && rawMinRight && rawMaxRight && rawFrames > 1) {
    for (let x = 0; x < length; x += 1) {
      const rawPos = rawStartPos + (x / Math.max(1, length - 1)) * rawVisible
      const rawIndex = Math.max(0, Math.min(rawFrames - 1, rawPos))
      const i0 = Math.floor(rawIndex)
      const i1 = Math.min(rawFrames - 1, i0 + 1)
      const t = rawIndex - i0
      const rawMinLeftValue = lerp(rawMinLeft[i0] || 0, rawMinLeft[i1] || 0, t)
      const rawMaxLeftValue = lerp(rawMaxLeft[i0] || 0, rawMaxLeft[i1] || 0, t)
      const rawMinRightValue = lerp(rawMinRight[i0] || 0, rawMinRight[i1] || 0, t)
      const rawMaxRightValue = lerp(rawMaxRight[i0] || 0, rawMaxRight[i1] || 0, t)
      const monoPeak = Math.max(
        Math.abs(rawMinLeftValue),
        Math.abs(rawMaxLeftValue),
        Math.abs(rawMinRightValue),
        Math.abs(rawMaxRightValue)
      )
      amplitudes[x] = monoPeak * rawHeightFactor
    }
  } else {
    if (!peakLeft || !peakRight) return
    for (let x = 0; x < length; x += 1) {
      const xSampleWidth = gain * x
      const xVisualSampleIndex = xSampleWidth + offset
      const maxSamplingRange = gain / 2
      let monoAmp = 0
      if (useInterpolatedSamples) {
        const framePos = Math.max(startFrame, Math.min(endFrame - 1, xVisualSampleIndex / 2))
        const i0 = Math.floor(framePos)
        const i1 = Math.min(endFrame - 1, i0 + 1)
        const t = framePos - i0
        const mono0 = Math.max(peakLeft[i0] || 0, peakRight[i0] || 0)
        const mono1 = Math.max(peakLeft[i1] || mono0, peakRight[i1] || mono0)
        monoAmp = lerp(mono0, mono1, t)
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
          const peak = Math.max(peakLeft[frameIndex] || 0, peakRight[frameIndex] || 0)
          if (peak > monoAmp) monoAmp = peak
        }
      }
      amplitudes[x] = monoAmp * heightFactor
    }
  }

  const drawMonoBand = (alpha: number) => {
    ctx.fillStyle = `rgba(${stemColor.r}, ${stemColor.g}, ${stemColor.b}, ${alpha})`
    for (let x = 0; x < length - 1; x += 1) {
      const curAmp = amplitudes[x] || 0
      const nextAmp = amplitudes[x + 1] || curAmp
      const x0 = x * pixelWidth
      const x1 = (x + 1) * pixelWidth

      ctx.beginPath()
      if (isHalf) {
        ctx.moveTo(x0, height)
        ctx.lineTo(x0, height - curAmp)
        ctx.lineTo(x1, height - nextAmp)
        ctx.lineTo(x1, height)
      } else {
        ctx.moveTo(x0, halfBreadth - curAmp)
        ctx.lineTo(x1, halfBreadth - nextAmp)
        ctx.lineTo(x1, halfBreadth + nextAmp)
        ctx.lineTo(x0, halfBreadth + curAmp)
      }
      ctx.closePath()
      ctx.fill()
    }
  }

  if (hasRaw) {
    drawMonoBand(STEM_WAVEFORM_RAW_ALPHA)
  } else {
    drawMonoBand(STEM_WAVEFORM_MAIN_ALPHA)
  }
  ctx.globalAlpha = 1
}
