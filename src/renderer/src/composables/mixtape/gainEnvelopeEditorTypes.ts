import type { Ref } from 'vue'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

export type EnvelopePointDot = {
  index: number
  x: number
  y: number
  isBoundary: boolean
}

export type EnvelopeDragState = {
  param: MixtapeEnvelopeParamId
  trackId: string
  pointIndex: number
  stageEl: HTMLElement
}

export type VolumeMuteSegmentMask = {
  key: string
  left: number
  width: number
}

export type VolumeMuteSelectionState = {
  trackId: string
  stageEl: HTMLElement
  baseSegments: MixtapeMuteSegment[]
  touched: Map<string, MixtapeMuteSegment>
  lastSec: number
}

export type MixParamUndoEntry =
  | {
      type: 'envelope'
      trackId: string
      param: MixtapeEnvelopeParamId
      points: MixtapeGainPoint[]
    }
  | {
      type: 'volumeMute'
      trackId: string
      segments: MixtapeMuteSegment[]
    }
  | {
      type: 'external'
      undo: () => boolean
    }

export type EnvelopeUndoSeed = {
  trackId: string
  param: MixtapeEnvelopeParamId
  points: MixtapeGainPoint[]
}

export type CreateMixtapeGainEnvelopeEditorParams = {
  tracks: Ref<MixtapeTrack[]>
  renderZoomLevel: Ref<number>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  resolveActiveParam: () => MixtapeEnvelopeParamId | null
  isVolumeMuteSelectionMode: () => boolean
  isEditable: () => boolean
}
