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

const normalizeSourceKind = (value: unknown): RekordboxSourceKind | null => {
  return value === 'desktop' || value === 'usb' ? value : null
}

export const resolveSongExternalWaveformSource = (
  song: ISongInfo | null | undefined,
  fallback?: {
    sourceKind?: RekordboxSourceKind | ''
    rootPath?: string | null | undefined
  }
): ResolvedExternalWaveformSource | null => {
  const externalAnalyzePath = String(
    song?.externalAnalyzePath || song?.pioneerAnalyzePath || ''
  ).trim()
  const externalRootPath = String(
    song?.externalWaveformRootPath || song?.pioneerDeviceRootPath || fallback?.rootPath || ''
  ).trim()
  if (!externalAnalyzePath || !externalRootPath) return null

  const sourceKind =
    normalizeSourceKind(song?.externalSourceKind) ||
    normalizeSourceKind(fallback?.sourceKind) ||
    'usb'

  return {
    sourceKind,
    analyzePath: externalAnalyzePath,
    rootPath: externalRootPath
  }
}

export const getRekordboxPreviewWaveformRequestChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'get-preview-waveforms')

export const getRekordboxPreviewWaveformStreamChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'stream-preview-waveforms')

export const getRekordboxCoverThumbChannel = (sourceKind: RekordboxSourceKind) =>
  buildRekordboxSourceChannel(sourceKind, 'get-cover-thumb')

export const getRekordboxPreviewWaveformItemEventChannel = (sourceKind: RekordboxSourceKind) =>
  getRekordboxPreviewWaveformItemChannel(sourceKind)

export const getRekordboxPreviewWaveformDoneEventChannel = (sourceKind: RekordboxSourceKind) =>
  getRekordboxPreviewWaveformDoneChannel(sourceKind)
