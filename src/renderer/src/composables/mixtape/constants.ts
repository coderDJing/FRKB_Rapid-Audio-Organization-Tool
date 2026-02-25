export const MIXTAPE_TRACK_UI_SCALE = 1.5
export const MIXTAPE_BASE_TRACK_LANE_HEIGHT = Math.round(
  Math.max(28, 36) * 4 * MIXTAPE_TRACK_UI_SCALE
)
export const MIXTAPE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT = 63
export const MIXTAPE_OVERVIEW_BASE_LANE_HEIGHT = 12
export const BASE_PX_PER_SEC = 80
export const MIXTAPE_WIDTH_SCALE = 0.1 * MIXTAPE_TRACK_UI_SCALE
export const MIN_TRACK_WIDTH = Math.max(6, Math.round(60 * MIXTAPE_WIDTH_SCALE))
export const FALLBACK_TRACK_WIDTH = Math.max(12, Math.round(120 * MIXTAPE_WIDTH_SCALE))
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 20
export const ZOOM_STEP = 0.1
export const RENDER_ZOOM_STEP = 0.05
export const WHEEL_ZOOM_BASE_STEP = 0.08
export const WHEEL_ZOOM_RATIO_STEP = 0.025
export const WHEEL_ZOOM_MAX_STEP = 0.3
export const WHEEL_MAX_STEPS_PER_FRAME = 1
export const WHEEL_LINE_HEIGHT_PX = 16
export const LANE_GAP = 8
export const LANE_COUNT = 2
export const LANE_PADDING_TOP = 10
export const TIMELINE_SIDE_PADDING_PX = 18
export const MIXTAPE_WAVEFORM_Y_OFFSET = 1
export const PRE_RENDER_RANGE_BUFFER = 1.2
export const SHOW_GRID_LINES = true
export const GRID_BAR_ONLY_ZOOM = 0.6
export const GRID_DETAIL_SPLIT_MIN_ZOOM = ZOOM_MIN
export const GRID_DETAIL_SPLIT_MAX_ZOOM = ZOOM_MAX
const GRID_DETAIL_SPLIT_SPAN = Math.max(0, GRID_DETAIL_SPLIT_MAX_ZOOM - GRID_DETAIL_SPLIT_MIN_ZOOM)
export const GRID_BEAT4_LINE_ZOOM = 3
export const GRID_BEAT_LINE_ZOOM = GRID_DETAIL_SPLIT_MIN_ZOOM + (GRID_DETAIL_SPLIT_SPAN * 2) / 3
export const GRID_BAR_WIDTH_MIN = 1.6
export const GRID_BAR_WIDTH_MAX = 2.6
export const GRID_BAR_WIDTH_MAX_ZOOM = 1.2
export const MIXTAPE_WAVEFORM_HEIGHT_SCALE = 0.72
export const MIXTAPE_WAVEFORM_SUPERSAMPLE = 2
export const RAW_WAVEFORM_TARGET_RATE = 2400
export const RAW_WAVEFORM_MIN_ZOOM = ZOOM_MIN
export const MIXTAPE_SUMMARY_ZOOM = 0
export const WAVEFORM_TILE_WIDTH = 1200
export const RENDER_X_BUFFER_PX = WAVEFORM_TILE_WIDTH
export const WAVEFORM_BATCH_SIZE = 6
export const RAW_WAVEFORM_BATCH_SIZE = 3
export const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
export const MIXXX_RGB_COMPONENTS = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}
