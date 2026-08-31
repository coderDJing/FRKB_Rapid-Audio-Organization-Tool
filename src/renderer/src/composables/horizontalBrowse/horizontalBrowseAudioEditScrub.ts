import { mapAudioEditPlanToSource, type AudioEditClip } from '@shared/audioEditTimeline'
import type { DeckWaveformScrubPreviewPayload } from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckPlaybackState'

export const resolveHorizontalBrowseAudioEditScrubPreview = (
  clips: readonly AudioEditClip[],
  payload: DeckWaveformScrubPreviewPayload
): DeckWaveformScrubPreviewPayload | null => {
  const mapped = mapAudioEditPlanToSource(clips, payload.anchorSec)
  if (!mapped) return null
  return {
    anchorSec: mapped.sourceSec,
    playbackRate: payload.playbackRate
  }
}
