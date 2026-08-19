import type { ISongInfo } from 'src/types/globals'
import { getKeyDisplayText as formatKeyDisplayText } from '@shared/keyDisplay'
import { summarizeSongBeatGridV2Bpm } from '@shared/songBeatGridMapV2'
import { formatDeletedAtMs, getOriginalPlaylistDisplay } from '@renderer/utils/recycleBinDisplay'
import { t } from '@renderer/utils/translate'

export type SongListFieldDisplayOptions = {
  keyDisplayStyle: 'Classic' | 'Camelot'
  isDesktopRekordboxSong: boolean
}

export const resolveSongListKeyDisplayStyle = (value: unknown): 'Classic' | 'Camelot' =>
  value === 'Camelot' ? 'Camelot' : 'Classic'

const EMPTY_PLACEHOLDER = '-'

const formatKeyText = (value: unknown, style: 'Classic' | 'Camelot'): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  const display = formatKeyDisplayText(text, style)
  if (display.toLowerCase() === 'o') {
    return t('player.keyDisplayNone')
  }
  return display
}

export const getSongListFieldDisplayValue = (
  song: ISongInfo,
  colKey: string,
  options: SongListFieldDisplayOptions
): string | number => {
  if (colKey === 'key') {
    if (options.isDesktopRekordboxSong && !String(song.key || '').trim()) {
      return t('rekordboxDesktop.analysisRequired')
    }
    return formatKeyText(song.key, options.keyDisplayStyle)
  }
  if (colKey === 'deletedAtMs') {
    return formatDeletedAtMs(song.deletedAtMs)
  }
  if (colKey === 'originalPlaylistPath') {
    return getOriginalPlaylistDisplay(song)
  }
  const raw = song[colKey as keyof ISongInfo]
  if (colKey === 'bpm') {
    const bpmSummary = summarizeSongBeatGridV2Bpm(song.beatGridMap, song.bpm)
    if (bpmSummary.displayText) {
      return bpmSummary.displayText
    }
    if (song.beatGridStatus === 'no-bpm') {
      return t('tracks.noBpm')
    }
    return options.isDesktopRekordboxSong ? t('rekordboxDesktop.analysisRequired') : ''
  }
  if (colKey === 'energyScore') {
    const energyScore = Number(raw)
    if (Number.isFinite(energyScore)) {
      return Math.max(0, Math.min(100, Math.round(energyScore)))
    }
    return ''
  }
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  return String(raw)
}

export const getSongListFieldDisplayTitle = (
  song: ISongInfo,
  colKey: string,
  options: SongListFieldDisplayOptions
): string => {
  if (colKey === 'bpm') {
    const bpmSummary = summarizeSongBeatGridV2Bpm(song.beatGridMap, song.bpm)
    if (bpmSummary.titleText) return bpmSummary.titleText
  }
  return String(getSongListFieldDisplayValue(song, colKey, options))
}

export const formatSongListFieldOrDash = (value: string | number): string => {
  const text = String(value ?? '').trim()
  return text || EMPTY_PLACEHOLDER
}
