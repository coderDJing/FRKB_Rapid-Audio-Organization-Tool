import { BPM_INTERNAL_DECIMALS, formatBpmDisplay } from '@renderer/utils/bpm'
import { resizeCanvasWithScaleMetrics } from '@renderer/utils/canvasScale'

export const PREVIEW_RAW_TARGET_RATE = 4800
export const PREVIEW_EDIT_RAW_TARGET_RATE = 44100
export const PREVIEW_WARMUP_DELAY_MS = 600
export const PREVIEW_WARMUP_EAGER_DELAY_MS = 0
export const OVERVIEW_MAX_RENDER_COLUMNS = 960
export const OVERVIEW_WAVEFORM_VERTICAL_PADDING = 8
export const PREVIEW_MAX_SAMPLES_PER_PIXEL = 180
export const PREVIEW_PLAY_ANCHOR_RATIO = 1 / 3
export const PREVIEW_SHORTCUT_FALLBACK_BPM = 128
export const PREVIEW_BPM_INTERNAL_DECIMALS = BPM_INTERNAL_DECIMALS
export const PREVIEW_BPM_STEP = 0.01
export const PREVIEW_BPM_MIN = 1
export const PREVIEW_BPM_MAX = 300
export const PREVIEW_SHORTCUT_BEATS = 4
export const PREVIEW_BAR_BEAT_INTERVAL = 32
export const PREVIEW_BAR_LINE_HIT_RADIUS_PX = 14
export const PREVIEW_GRID_SHIFT_SMALL_MS = 5
export const PREVIEW_GRID_SHIFT_LARGE_MS = 20
export const PREVIEW_BPM_TAP_RESET_MS = 5000
export const PREVIEW_BPM_TAP_MIN_DELTA_MS = 50
export const PREVIEW_BPM_TAP_MAX_DELTA_MS = 2000
export const PREVIEW_BPM_TAP_MAX_COUNT = 8
const OVERVIEW_VIEWPORT_MIN_WIDTH = 12

export const normalizePathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

export const normalizePreviewBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return PREVIEW_SHORTCUT_FALLBACK_BPM
  const clamped = Math.max(PREVIEW_BPM_MIN, Math.min(PREVIEW_BPM_MAX, numeric))
  return Number(clamped.toFixed(PREVIEW_BPM_INTERNAL_DECIMALS))
}

export const formatPreviewBpm = (value: unknown) => formatBpmDisplay(normalizePreviewBpm(value))

export const parsePreviewBpmInput = (value: string) => {
  const normalized = String(value || '')
    .trim()
    .replace(',', '.')
  if (!normalized) return null
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return null
  const numeric = Number(normalized)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return normalizePreviewBpm(numeric)
}

type ResolveOverviewViewportMetricsParams = {
  durationSec: number
  visibleDurationSec: number
  leadingPadSec: number
  virtualSpanSec: number
  wrapWidth: number
  startSec: number
}

export const resolveOverviewViewportMetricsByRange = (
  params: ResolveOverviewViewportMetricsParams
) => {
  if (!params.durationSec || !params.visibleDurationSec || params.wrapWidth <= 0) {
    return { left: 0, width: 0, wrapWidth: 0 }
  }
  const safeVisible = clampNumber(params.visibleDurationSec, 0.0001, params.virtualSpanSec)
  if (safeVisible >= params.virtualSpanSec) {
    return { left: 0, width: params.wrapWidth, wrapWidth: params.wrapWidth }
  }
  const rawWidth = (safeVisible / params.virtualSpanSec) * params.wrapWidth
  const width = clampNumber(rawWidth, OVERVIEW_VIEWPORT_MIN_WIDTH, params.wrapWidth)
  const maxLeftTime = Math.max(0, params.virtualSpanSec - safeVisible)
  const minStart = -Math.max(0, params.leadingPadSec)
  const maxStart = Math.max(minStart, params.virtualSpanSec - safeVisible - params.leadingPadSec)
  const safeStart = clampNumber(params.startSec, minStart, maxStart)
  const leftTime = safeStart + params.leadingPadSec
  const startRatio = maxLeftTime > 0 ? leftTime / maxLeftTime : 0
  const maxLeft = Math.max(0, params.wrapWidth - width)
  const left = startRatio * maxLeft
  return { left, width, wrapWidth: params.wrapWidth }
}

export const resizePreviewCanvasByPixelRatio = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) => {
  resizeCanvasWithScaleMetrics(canvas, ctx, width, height, window.devicePixelRatio || 1)
}

export const isEditableEventTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase() || ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}
