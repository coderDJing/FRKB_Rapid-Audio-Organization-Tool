import type { Ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'

export type HorizontalBrowseDirection = 'up' | 'down'
export type HorizontalBrowseWaveformLayout = 'full' | 'top-half' | 'bottom-half'
export type HorizontalBrowseWaveformRenderStyle = 'columns' | 'raw-curve'

export type UseHorizontalBrowseRawWaveformCanvasOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  cueSeconds: () => number | undefined
  hotCues: () => ISongHotCue[] | null | undefined
  memoryCues: () => ISongMemoryCue[] | null | undefined
  loopRange: () => { startSec: number; endSec: number } | null | undefined
  currentSeconds: () => number | undefined
  playbackRate: () => number | undefined
  visualPlaybackRate?: () => number | undefined
  waveformGain?: () => number | undefined
  playing: Ref<boolean>
  playbackSyncRevision: Readonly<Ref<number>>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  previewBpm: Readonly<Ref<number>>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
  dragging: Ref<boolean>
  previewLoading: Ref<boolean>
  allowNegativeTimeline: () => boolean
  waveformLayout: () => HorizontalBrowseWaveformLayout
  waveformRenderStyle: () => HorizontalBrowseWaveformRenderStyle
  stableWaveformSource?: () => boolean
  stableRenderRevision?: () => number
  linkedGridActive?: () => boolean
  phaseAwareScrollReuse?: () => boolean
}
