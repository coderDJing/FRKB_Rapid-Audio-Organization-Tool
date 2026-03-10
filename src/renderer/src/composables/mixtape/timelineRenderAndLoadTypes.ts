import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { StemWaveformData } from '@renderer/composables/mixtape/types'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'

export type StemWaveformBatchRequestItem = {
  listRoot?: string
  sourceFilePath: string
  stemMode: typeof FIXED_MIXTAPE_STEM_MODE
  stemModel?: string
  stemVersion?: string
  stemPaths: {
    vocalPath?: string
    instPath?: string
    bassPath?: string
    drumsPath?: string
  }
}

export type TimelineWaveformData = StemWaveformData | MixxxWaveformData
