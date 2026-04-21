import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import {
  normalizeSongHotCues,
  resolveSongHotCueDisplayColor,
  resolveSongHotCueDisplayLabel
} from '@shared/hotCues'
import { normalizeSongMemoryCues, resolveSongMemoryCueDisplayColor } from '@shared/memoryCues'
import { resolveHorizontalBrowseTimePercent } from '@renderer/components/horizontalBrowseDetailMath'

type HorizontalBrowseDirection = 'up' | 'down'

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

type DrawHorizontalBrowseDetailOverlayOptions = {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  waveformHeight: number
  overlayInsetPx: number
  direction: HorizontalBrowseDirection
  rangeStartSec: number
  rangeDurationSec: number
  cueSeconds?: number
  hotCues?: ISongHotCue[] | null
  memoryCues?: ISongMemoryCue[] | null
  loopRange?: HorizontalBrowseLoopRange | null
}

const CUE_MARKER_WIDTH = 10
const CUE_MARKER_HEIGHT = 7
const MEMORY_CUE_WIDTH = 10
const MEMORY_CUE_HEIGHT = 7
const HOT_CUE_LABEL_HEIGHT = 14
const HOT_CUE_LABEL_MIN_WIDTH = 18
const HOT_CUE_LABEL_PADDING_X = 4
const HOT_CUE_FONT = '700 9px "Segoe UI", sans-serif'
const HOT_CUE_OFFSET_PX = -8
const MEMORY_CUE_OFFSET_PX = -8

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const pathRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const safeRadius = clampNumber(radius, 0, Math.min(width, height) * 0.5)
  ctx.beginPath()
  ctx.moveTo(x + safeRadius, y)
  ctx.lineTo(x + width - safeRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  ctx.lineTo(x + width, y + height - safeRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  ctx.lineTo(x + safeRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  ctx.lineTo(x, y + safeRadius)
  ctx.quadraticCurveTo(x, y, x + safeRadius, y)
  ctx.closePath()
}

const resolveCueAccentColor = () => {
  const cssValue = getComputedStyle(document.documentElement)
    .getPropertyValue('--shell-cue-accent')
    .trim()
  return cssValue || '#d98921'
}

const resolveMarkerCenterX = (
  seconds: number | undefined,
  rangeStartSec: number,
  rangeDurationSec: number,
  width: number
) => {
  const ratio = resolveHorizontalBrowseTimePercent(Number(seconds), rangeStartSec, rangeDurationSec)
  if (ratio === null) return null
  return ratio * width
}

const drawCueTriangle = (
  ctx: CanvasRenderingContext2D,
  centerX: number,
  topY: number,
  direction: HorizontalBrowseDirection,
  fillColor: string
) => {
  const left = centerX - CUE_MARKER_WIDTH * 0.5
  const right = left + CUE_MARKER_WIDTH
  const bottom = topY + CUE_MARKER_HEIGHT

  ctx.beginPath()
  if (direction === 'up') {
    ctx.moveTo(centerX, topY)
    ctx.lineTo(left, bottom)
    ctx.lineTo(right, bottom)
  } else {
    ctx.moveTo(left, topY)
    ctx.lineTo(right, topY)
    ctx.lineTo(centerX, bottom)
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(0, 0, 0, 0.88)'
  ctx.fill()

  const inset = 1
  ctx.beginPath()
  if (direction === 'up') {
    ctx.moveTo(centerX, topY + inset)
    ctx.lineTo(left + inset, bottom - inset)
    ctx.lineTo(right - inset, bottom - inset)
  } else {
    ctx.moveTo(left + inset, topY + inset)
    ctx.lineTo(right - inset, topY + inset)
    ctx.lineTo(centerX, bottom - inset)
  }
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()
}

const drawMemoryCue = (
  ctx: CanvasRenderingContext2D,
  centerX: number,
  topY: number,
  anchor: 'top' | 'bottom',
  color: string
) => {
  const left = centerX - MEMORY_CUE_WIDTH * 0.5
  const right = left + MEMORY_CUE_WIDTH
  const bottom = topY + MEMORY_CUE_HEIGHT
  ctx.beginPath()
  if (anchor === 'top') {
    ctx.moveTo(left, topY)
    ctx.lineTo(right, topY)
    ctx.lineTo(centerX, bottom)
  } else {
    ctx.moveTo(centerX, topY)
    ctx.lineTo(left, bottom)
    ctx.lineTo(right, bottom)
  }
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

const drawHotCue = (
  ctx: CanvasRenderingContext2D,
  centerX: number,
  topY: number,
  label: string,
  color: string
) => {
  ctx.font = HOT_CUE_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const text = String(label || '').trim() || '?'
  const textWidth = ctx.measureText(text).width
  const boxWidth = Math.max(
    HOT_CUE_LABEL_MIN_WIDTH,
    Math.ceil(textWidth + HOT_CUE_LABEL_PADDING_X * 2)
  )
  const left = centerX - boxWidth * 0.5

  pathRoundedRect(ctx, left, topY, boxWidth, HOT_CUE_LABEL_HEIGHT, 3)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(18, 18, 18, 0.18)'
  ctx.stroke()

  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, centerX, topY + HOT_CUE_LABEL_HEIGHT * 0.5 + 0.5)
}

const drawLoopMask = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveformTop: number,
  waveformHeight: number,
  rangeStartSec: number,
  rangeDurationSec: number,
  cueAccent: string,
  loopRange?: HorizontalBrowseLoopRange | null
) => {
  if (!loopRange) return
  const visibleStartSec = Math.max(rangeStartSec, Number(loopRange.startSec) || 0)
  const visibleEndSec = Math.min(rangeStartSec + rangeDurationSec, Number(loopRange.endSec) || 0)
  if (visibleEndSec <= visibleStartSec) return
  const left = ((visibleStartSec - rangeStartSec) / rangeDurationSec) * width
  const rectWidth = ((visibleEndSec - visibleStartSec) / rangeDurationSec) * width
  if (rectWidth <= 0.0001) return

  ctx.save()
  ctx.globalAlpha = 0.28
  ctx.fillStyle = cueAccent
  ctx.fillRect(left, waveformTop, rectWidth, waveformHeight)
  ctx.restore()

  ctx.strokeStyle = cueAccent
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.46
  ctx.strokeRect(
    left + 0.5,
    waveformTop + 0.5,
    Math.max(0, rectWidth - 1),
    Math.max(0, waveformHeight - 1)
  )
  ctx.globalAlpha = 1
}

export const HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX = 12

export const drawHorizontalBrowseDetailOverlay = (
  options: DrawHorizontalBrowseDetailOverlayOptions
) => {
  const {
    ctx,
    width,
    height,
    waveformHeight,
    overlayInsetPx,
    direction,
    rangeStartSec,
    rangeDurationSec,
    cueSeconds,
    hotCues,
    memoryCues,
    loopRange
  } = options
  if (width <= 0 || height <= 0 || waveformHeight <= 0 || rangeDurationSec <= 0) return

  const waveformTop = overlayInsetPx
  const cueAccent = resolveCueAccentColor()
  drawLoopMask(
    ctx,
    width,
    height,
    waveformTop,
    waveformHeight,
    rangeStartSec,
    rangeDurationSec,
    cueAccent,
    loopRange
  )

  const cueCenterX = resolveMarkerCenterX(cueSeconds, rangeStartSec, rangeDurationSec, width)
  if (cueCenterX !== null) {
    const cueTopY =
      direction === 'up' ? waveformTop + waveformHeight - CUE_MARKER_HEIGHT : waveformTop
    drawCueTriangle(ctx, cueCenterX, cueTopY, direction, cueAccent)
  }

  const memoryAnchor = direction === 'up' ? 'top' : 'bottom'
  const memoryTopY =
    memoryAnchor === 'top'
      ? waveformTop + MEMORY_CUE_OFFSET_PX
      : waveformTop + waveformHeight - MEMORY_CUE_HEIGHT - MEMORY_CUE_OFFSET_PX
  for (const marker of normalizeSongMemoryCues(memoryCues)) {
    const centerX = resolveMarkerCenterX(marker.sec, rangeStartSec, rangeDurationSec, width)
    if (centerX === null) continue
    drawMemoryCue(ctx, centerX, memoryTopY, memoryAnchor, resolveSongMemoryCueDisplayColor(marker))
  }

  const hotCueTopY =
    direction === 'up'
      ? waveformTop + HOT_CUE_OFFSET_PX
      : waveformTop + waveformHeight - HOT_CUE_LABEL_HEIGHT - HOT_CUE_OFFSET_PX
  for (const marker of normalizeSongHotCues(hotCues)) {
    const centerX = resolveMarkerCenterX(marker.sec, rangeStartSec, rangeDurationSec, width)
    if (centerX === null) continue
    drawHotCue(
      ctx,
      centerX,
      hotCueTopY,
      resolveSongHotCueDisplayLabel(marker),
      resolveSongHotCueDisplayColor(marker)
    )
  }
}
