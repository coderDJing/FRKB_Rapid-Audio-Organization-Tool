import type { ISongInfo } from 'src/types/globals'
import {
  BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY,
  normalizeBrowserPlayerRightTrackInfo,
  type BrowserPlayerRightTrackInfoField
} from '@shared/browserPlayerRightTrackInfo'
import {
  formatSongListFieldOrDash,
  getSongListFieldDisplayTitle,
  getSongListFieldDisplayValue,
  type SongListFieldDisplayOptions
} from './songListFieldDisplay'

export type BrowserPlayerRightTrackInfoText = {
  displayText: string
  titleText: string
}

const combineBpmAndKey = (bpmText: string, keyText: string) => `${bpmText} · ${keyText}`

export const formatBrowserPlayerRightTrackInfoText = (
  song: ISongInfo | null | undefined,
  fieldInput: unknown,
  options: SongListFieldDisplayOptions
): BrowserPlayerRightTrackInfoText => {
  const field: BrowserPlayerRightTrackInfoField = normalizeBrowserPlayerRightTrackInfo(fieldInput)
  if (!song) {
    return { displayText: '-', titleText: '-' }
  }
  if (field === BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY) {
    const bpmText = formatSongListFieldOrDash(getSongListFieldDisplayValue(song, 'bpm', options))
    const keyText = formatSongListFieldOrDash(getSongListFieldDisplayValue(song, 'key', options))
    const bpmTitle = formatSongListFieldOrDash(getSongListFieldDisplayTitle(song, 'bpm', options))
    return {
      displayText: combineBpmAndKey(bpmText, keyText),
      titleText: combineBpmAndKey(bpmTitle, keyText)
    }
  }
  const displayText = formatSongListFieldOrDash(getSongListFieldDisplayValue(song, field, options))
  const titleText = formatSongListFieldOrDash(getSongListFieldDisplayTitle(song, field, options))
  return { displayText, titleText }
}
