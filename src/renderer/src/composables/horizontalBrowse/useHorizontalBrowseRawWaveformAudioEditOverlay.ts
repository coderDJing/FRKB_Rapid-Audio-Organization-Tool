import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import type { HorizontalBrowseLoopRange } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import {
  resolveAudioEditOverlayViewport,
  resolveAudioEditViewportBoundStyle,
  resolveAudioEditViewportSelectionStyle
} from '@renderer/composables/horizontalBrowse/audioEditDetailSelectionOverlay'

type ReadonlyValue<T> = Readonly<{ value: T }>

type AudioEditOverlayBound = {
  kind: 'start' | 'end'
  label: string
  sec: number | null | undefined
}

type HorizontalBrowseRawWaveformAudioEditOverlayParams = {
  hasSong: () => boolean
  selection: () => HorizontalBrowseLoopRange | null | undefined
  pendingStartSec: () => number | null | undefined
  pendingEndSec: () => number | null | undefined
  insertedRanges: () => HorizontalBrowseLoopRange[] | null | undefined
  dragging: ReadonlyValue<boolean>
  displayViewportStartSec: ReadonlyValue<number>
  displayViewportDurationSec: ReadonlyValue<number>
  previewStartSec: ReadonlyValue<number>
  resolveVisibleDurationSec: () => number
}

export const useHorizontalBrowseRawWaveformAudioEditOverlay = (
  params: HorizontalBrowseRawWaveformAudioEditOverlayParams
) => {
  const overlayViewport = computed(() =>
    resolveAudioEditOverlayViewport({
      dragging: params.dragging.value,
      displayViewportStartSec: params.displayViewportStartSec.value,
      displayViewportDurationSec: params.displayViewportDurationSec.value,
      previewStartSec: params.previewStartSec.value,
      visibleDurationSec: params.resolveVisibleDurationSec()
    })
  )
  const viewportStartSec = computed(() => overlayViewport.value.startSec)
  const viewportDurationSec = computed(() => overlayViewport.value.durationSec)
  const audioEditSelectionStyle = computed(() => {
    if (!params.hasSong()) return null
    return resolveAudioEditViewportSelectionStyle(
      params.selection(),
      viewportStartSec.value,
      viewportDurationSec.value
    )
  })
  const audioEditInsertedStyles = computed(() => {
    if (!params.hasSong()) return []
    return (params.insertedRanges() || []).flatMap((range, index) => {
      const style = resolveAudioEditViewportSelectionStyle(
        range,
        viewportStartSec.value,
        viewportDurationSec.value
      )
      return style ? [{ key: `${range.startSec}-${range.endSec}-${index}`, style }] : []
    })
  })
  const audioEditBoundStyles = computed(() => {
    if (!params.hasSong()) return []
    const selection = params.selection()
    const bounds: AudioEditOverlayBound[] = selection
      ? [
          {
            kind: 'start',
            label: t('audioEdit.boundStartShort'),
            sec: selection.startSec
          },
          {
            kind: 'end',
            label: t('audioEdit.boundEndShort'),
            sec: selection.endSec
          }
        ]
      : [
          {
            kind: 'start',
            label: t('audioEdit.boundStartShort'),
            sec: params.pendingStartSec()
          },
          {
            kind: 'end',
            label: t('audioEdit.boundEndShort'),
            sec: params.pendingEndSec()
          }
        ]
    return bounds.flatMap((bound) => {
      const style = resolveAudioEditViewportBoundStyle(
        bound.sec,
        viewportStartSec.value,
        viewportDurationSec.value
      )
      return style ? [{ key: `${bound.kind}-${bound.sec}`, ...bound, style }] : []
    })
  })

  return {
    audioEditSelectionStyle,
    audioEditInsertedStyles,
    audioEditBoundStyles
  }
}
