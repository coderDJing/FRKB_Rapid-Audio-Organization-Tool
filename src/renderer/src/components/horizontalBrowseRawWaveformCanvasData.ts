import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { isRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformData'

const DEFAULT_CUE_ACCENT_COLOR = '#d98921'

export const resolveHorizontalBrowseCueAccentColor = () => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--shell-cue-accent')
    .trim()
  return value || DEFAULT_CUE_ACCENT_COLOR
}

export const resolveHorizontalBrowseActiveMixxxSelection = (
  liveMixxxData: MixxxWaveformData | null
) => {
  if (liveMixxxData && !isRawPlaceholderMixxxData(liveMixxxData)) {
    return { data: liveMixxxData, source: 'live' as const }
  }
  if (liveMixxxData) {
    return { data: liveMixxxData, source: 'placeholder' as const }
  }
  return { data: null, source: 'none' as const }
}
