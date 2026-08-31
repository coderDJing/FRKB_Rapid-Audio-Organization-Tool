import { toRaw, watch, type Ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformPlaceholder'
import { remapAudioEditRawWaveform } from '@renderer/composables/horizontalBrowse/audioEditCompactWaveform'
import { AUDIO_EDIT_EPSILON_SEC, type AudioEditClip } from '@shared/audioEditTimeline'

type UseHorizontalBrowseAudioEditDetailRawOptions = {
  clips: () => readonly AudioEditClip[] | null | undefined
  sourceRawData: Ref<RawWaveformData | null>
  displayRawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  replaceLiveWaveformRaw: (data: RawWaveformData | null) => void
  resetPlaybackRenderState: (options?: { preserveDisplay?: boolean }) => void
  reanchorViewport: () => void
  scheduleDraw: (options?: { preferPreviewStart?: boolean }) => void
}

const serializeAudioEditClipsKey = (clips: readonly AudioEditClip[] | null | undefined) =>
  (clips || []).map((clip) => `${clip.sourceStartSec}:${clip.sourceEndSec}`).join('|')

export const useHorizontalBrowseAudioEditDetailRaw = (
  options: UseHorizontalBrowseAudioEditDetailRawOptions
) => {
  const applyFromSource = (resetViewport: boolean) => {
    const previousDuration = Number(options.displayRawData.value?.duration) || 0
    const source = options.sourceRawData.value
    const display = remapAudioEditRawWaveform(source ? toRaw(source) : null, options.clips() || [])
    options.displayRawData.value = display
    options.mixxxData.value = display ? createRawPlaceholderMixxxData(display) : null
    options.replaceLiveWaveformRaw(display)
    const nextDuration = Number(display?.duration) || 0
    const durationChanged = Math.abs(nextDuration - previousDuration) > AUDIO_EDIT_EPSILON_SEC
    if (!resetViewport || !durationChanged) {
      if (resetViewport) options.scheduleDraw()
      return
    }
    // 时长变了也要留着上一帧，等新波形画完再换；清 canvas 会让大波形先整块变黑。
    options.resetPlaybackRenderState({ preserveDisplay: true })
    options.reanchorViewport()
    options.scheduleDraw({ preferPreviewStart: true })
  }

  const commitSource = (data: RawWaveformData | null, resetViewport = false) => {
    options.sourceRawData.value = data
    applyFromSource(resetViewport)
  }

  watch(
    () => serializeAudioEditClipsKey(options.clips()),
    (next, previous) => {
      if (previous === undefined || next === previous) return
      applyFromSource(true)
    }
  )

  return {
    commitSource
  }
}
