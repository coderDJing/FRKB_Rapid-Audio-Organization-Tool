import type { ISongInfo } from 'src/types/globals'
import {
  buildRekordboxSourceChannel,
  getRekordboxPreviewWaveformDoneChannel,
  getRekordboxPreviewWaveformItemChannel,
  type RekordboxSourceKind
} from '@shared/rekordboxSources'

type ResolvedExternalWaveformSource = {
  sourceKind: RekordboxSourceKind
  analyzePath: string
  rootPath: string
}

const normalizeRekordboxSourceKind = (value: unknown): RekordboxSourceKind | null => {
  return value === 'desktop' || value === 'usb' ? value : null
}

export const isRekordboxExternalPlaybackSource = (
  songListUUID: string | null | undefined,
  song: ISongInfo | null | undefined
): boolean => {
  const sourceKind = normalizeRekordboxSourceKind(song?.externalSourceKind)
  if (sourceKind) return true

  const normalizedSongListUUID = String(songListUUID || '')
    .trim()
    .toLowerCase()
  return normalizedSongListUUID.startsWith('desktop:') || normalizedSongListUUID.startsWith('usb:')
}

export const resolveSongExternalWaveformSource = (
  song: ISongInfo | null | undefined,
  fallback?: {
    sourceKind?: RekordboxSourceKind | ''
    rootPath?: string | null | undefined
  }
): ResolvedExternalWaveformSource | null => {
  // Only the explicitly tagged Rekordbox USB/Desktop projections may use this path.
  // A regular external file can have an analyze-like path too; it remains an FRKB source.
  const sourceKind =
    normalizeRekordboxSourceKind(song?.externalSourceKind) ||
    normalizeRekordboxSourceKind(fallback?.sourceKind)
  if (!sourceKind) return null

  const externalAnalyzePath = String(
    song?.externalAnalyzePath || song?.pioneerAnalyzePath || ''
  ).trim()
  const externalRootPath = String(
    song?.externalWaveformRootPath || song?.pioneerDeviceRootPath || fallback?.rootPath || ''
  ).trim()
  if (!externalAnalyzePath || !externalRootPath) return null

  return {
    sourceKind,
    analyzePath: externalAnalyzePath,
    rootPath: externalRootPath
  }
}

export const getRekordboxPreviewWaveformRequestChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'get-preview-waveforms')

export const getRekordboxDetailWaveformRequestChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'get-detail-waveforms')

export const getRekordboxPreviewWaveformStreamChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'stream-preview-waveforms')

export const getRekordboxCoverThumbChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'get-cover-thumb')

export const getRekordboxPreviewWaveformItemEventChannel = (sourceKind: RekordboxSourceKind) =>
  getRekordboxPreviewWaveformItemChannel(sourceKind)

export const getRekordboxPreviewWaveformDoneEventChannel = (sourceKind: RekordboxSourceKind) =>
  getRekordboxPreviewWaveformDoneChannel(sourceKind)
