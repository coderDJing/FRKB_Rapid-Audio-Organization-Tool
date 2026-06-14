export type WaveformTimelineTickPalette = {
  baseline: string
  minor: string
  major: string
  anchor: string
}

export type WaveformTimelineTickThemeVariant = 'light' | 'dark'

type WaveformTimelineTickCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

export type WaveformTimelineTickOptions = {
  playedPercent?: number
  layout?: 'full' | 'top-half' | 'bottom-half'
  active?: boolean
}

const TIMELINE_MINOR_TICK_SEC = 5
const TIMELINE_MAJOR_TICK_SEC = 30
const TIMELINE_ANCHOR_TICK_SEC = 60

const hasThemeClass = (className: string) => {
  if (typeof document === 'undefined') return false
  const htmlEl = document.documentElement
  const bodyEl = document.body
  const appEl = document.getElementById('app')
  return (
    htmlEl?.classList.contains(className) ||
    bodyEl?.classList.contains(className) ||
    appEl?.classList.contains(className)
  )
}

export const resolveWaveformTimelineTickThemeVariant = (
  mode?: unknown
): WaveformTimelineTickThemeVariant => {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  if (hasThemeClass('theme-light')) return 'light'
  if (hasThemeClass('theme-dark')) return 'dark'
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export const resolveWaveformTimelineTickPalette = (
  active: boolean,
  themeVariant: WaveformTimelineTickThemeVariant
): WaveformTimelineTickPalette => {
  if (themeVariant === 'light') {
    return active
      ? {
          baseline: 'rgba(15, 23, 42, 0.16)',
          minor: 'rgba(15, 23, 42, 0.22)',
          major: 'rgba(15, 23, 42, 0.32)',
          anchor: 'rgba(15, 23, 42, 0.4)'
        }
      : {
          baseline: 'rgba(15, 23, 42, 0.07)',
          minor: 'rgba(15, 23, 42, 0.11)',
          major: 'rgba(15, 23, 42, 0.19)',
          anchor: 'rgba(15, 23, 42, 0.25)'
        }
  }

  return active
    ? {
        baseline: 'rgba(255, 255, 255, 0.22)',
        minor: 'rgba(255, 255, 255, 0.3)',
        major: 'rgba(255, 255, 255, 0.44)',
        anchor: 'rgba(255, 255, 255, 0.54)'
      }
    : {
        baseline: 'rgba(255, 255, 255, 0.08)',
        minor: 'rgba(255, 255, 255, 0.14)',
        major: 'rgba(255, 255, 255, 0.24)',
        anchor: 'rgba(255, 255, 255, 0.3)'
      }
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

const resolveTickVerticalRange = (
  height: number,
  layout: WaveformTimelineTickOptions['layout'] = 'full'
) => {
  if (layout === 'top-half') {
    return { top: 0, height: Math.max(1, height / 2) }
  }
  if (layout === 'bottom-half') {
    const halfHeight = Math.max(1, height / 2)
    return { top: height - halfHeight, height: halfHeight }
  }
  return { top: 0, height }
}

const drawTimelineTickTrack = (
  ctx: WaveformTimelineTickCanvasContext,
  width: number,
  height: number,
  palette: WaveformTimelineTickPalette,
  duration: number,
  layout: WaveformTimelineTickOptions['layout'] = 'full'
) => {
  const range = resolveTickVerticalRange(height, layout)
  const rangeHeight = Math.max(1, Math.floor(range.height))
  const top = Math.round(range.top)
  const centerY = Math.round(top + rangeHeight / 2)
  const minorHeight = Math.max(3, Math.min(rangeHeight, Math.round(rangeHeight * 0.3)))
  const majorHeight = Math.max(
    minorHeight + 1,
    Math.min(rangeHeight, Math.round(rangeHeight * 0.55))
  )
  const anchorHeight = Math.max(
    majorHeight + 1,
    Math.min(rangeHeight, Math.round(rangeHeight * 0.82))
  )

  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = palette.baseline
  ctx.fillRect(0, centerY, width, 1)

  const drawTick = (x: number, tickHeight: number, color: string) => {
    const safeHeight = Math.max(1, Math.min(tickHeight, rangeHeight))
    const tickY = Math.max(top, Math.round(centerY - safeHeight / 2))
    ctx.fillStyle = color
    ctx.fillRect(Math.min(width - 1, Math.max(0, Math.round(x))), tickY, 1, safeHeight)
  }

  const safeDuration = Math.max(0, Number(duration) || 0)
  if (!safeDuration) {
    for (let x = 4, index = 0; x < width; x += 8, index += 1) {
      const isAnchorTick = index % 12 === 0
      const isMajorTick = index % 6 === 0
      drawTick(
        x,
        isAnchorTick ? anchorHeight : isMajorTick ? majorHeight : minorHeight,
        isAnchorTick ? palette.anchor : isMajorTick ? palette.major : palette.minor
      )
    }
    return
  }

  for (let second = 0; second <= safeDuration; second += TIMELINE_MINOR_TICK_SEC) {
    const isAnchorTick = second % TIMELINE_ANCHOR_TICK_SEC === 0
    const isMajorTick = second % TIMELINE_MAJOR_TICK_SEC === 0
    drawTick(
      (second / safeDuration) * width,
      isAnchorTick ? anchorHeight : isMajorTick ? majorHeight : minorHeight,
      isAnchorTick ? palette.anchor : isMajorTick ? palette.major : palette.minor
    )
  }
}

export const drawWaveformTimelineTicks = (
  ctx: WaveformTimelineTickCanvasContext,
  width: number,
  height: number,
  duration: number,
  themeVariant: WaveformTimelineTickThemeVariant,
  options: WaveformTimelineTickOptions = {}
) => {
  const activePalette = resolveWaveformTimelineTickPalette(options.active === true, themeVariant)
  const playedPercent = clamp01(Number(options.playedPercent) || 0)
  drawTimelineTickTrack(ctx, width, height, activePalette, duration, options.layout)
  if (playedPercent <= 0 || options.active === true) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, width * playedPercent, height)
  ctx.clip()
  drawTimelineTickTrack(
    ctx,
    width,
    height,
    resolveWaveformTimelineTickPalette(true, themeVariant),
    duration,
    options.layout
  )
  ctx.restore()
}
