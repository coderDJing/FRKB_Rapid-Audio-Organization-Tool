import type { RawWaveformData } from '@renderer/composables/mixtape/types'

export type HorizontalBrowseWaveformThemeVariant = 'light' | 'dark'

export type HorizontalBrowseDetailWaveformTileRequest = {
  requestToken: number
  filePath: string
  cacheKey: string
  width: number
  height: number
  pixelRatio: number
  rangeStartSec: number
  rangeDurationSec: number
  maxSamplesPerPixel: number
  themeVariant: HorizontalBrowseWaveformThemeVariant
  waveformLayout: 'top-half' | 'bottom-half'
}

export type HorizontalBrowseDetailWaveformWorkerIncoming =
  | {
      type: 'storeRaw'
      payload: {
        filePath: string
        data: RawWaveformData | null
      }
    }
  | {
      type: 'renderBatch'
      payload: {
        requests: HorizontalBrowseDetailWaveformTileRequest[]
      }
    }
  | {
      type: 'clearQueue'
    }

export type HorizontalBrowseDetailWaveformWorkerOutgoing = {
  type: 'tileRendered'
  payload: {
    requestToken: number
    filePath: string
    cacheKey: string
    rangeStartSec: number
    rangeDurationSec: number
    width: number
    height: number
    pixelRatio: number
    bitmap: ImageBitmap | null
  }
}
