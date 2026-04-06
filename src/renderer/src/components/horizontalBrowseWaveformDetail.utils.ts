import type { HorizontalBrowseWaveformThemeVariant } from '@renderer/workers/horizontalBrowseDetailWaveform.types'

export const normalizeHorizontalBrowsePathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

export const disposeHorizontalBrowseWaveformBitmap = (bitmap: ImageBitmap | null | undefined) => {
  if (!bitmap) return
  try {
    bitmap.close()
  } catch {}
}

export const resolveHorizontalBrowseWaveformThemeVariant =
  (): HorizontalBrowseWaveformThemeVariant => {
    const htmlEl = document.documentElement
    const bodyEl = document.body
    if (htmlEl?.classList.contains('theme-light') || bodyEl?.classList.contains('theme-light')) {
      return 'light'
    }
    return 'dark'
  }

export const buildHorizontalBrowseWaveformTileCacheKey = (params: {
  filePath: string
  waveformLayout: 'top-half' | 'bottom-half'
  themeVariant: HorizontalBrowseWaveformThemeVariant
  zoom: number
  timeScale: number
  cssWidth: number
  cssHeight: number
  pixelRatio: number
  tileIndex: number
}) =>
  [
    normalizeHorizontalBrowsePathKey(params.filePath),
    params.waveformLayout,
    params.themeVariant,
    Number(params.zoom || 0).toFixed(6),
    Number(params.timeScale || 1).toFixed(6),
    Math.max(1, Math.floor(params.cssWidth)),
    Math.max(1, Math.floor(params.cssHeight)),
    Number(params.pixelRatio || 1).toFixed(3),
    params.tileIndex
  ].join('|')
