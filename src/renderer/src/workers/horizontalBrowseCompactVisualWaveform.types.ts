import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'

export type HorizontalBrowseCompactVisualWaveformWorkerIncoming = {
  type: 'buildStrip'
  payload: {
    token: number
    data: CompactVisualWaveformData | UnifiedDisplayWaveformDetailData
  }
}

export type HorizontalBrowseCompactVisualWaveformWorkerOutgoing =
  | {
      type: 'stripReady'
      payload: {
        token: number
        data: RawWaveformData | null
      }
    }
  | {
      type: 'stripFailed'
      payload: {
        token: number
        error: string
      }
    }
