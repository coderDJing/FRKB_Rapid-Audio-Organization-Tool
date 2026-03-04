import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { StemWaveformData } from '@renderer/composables/mixtape/types'

export type StemWaveformBatchRequestItem = {
  listRoot?: string
  sourceFilePath: string
  stemMode: '4stems'
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
