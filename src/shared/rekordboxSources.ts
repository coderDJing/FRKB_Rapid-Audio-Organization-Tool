export type RekordboxSourceKind = 'usb' | 'desktop'

export type RekordboxSourceLibraryType = 'deviceLibrary' | 'oneLibrary' | 'masterDb'

export type RekordboxSourceNamespace = 'pioneer-device-library' | 'rekordbox-desktop-library'

const REKORDBOX_SOURCE_NAMESPACE_MAP: Record<RekordboxSourceKind, RekordboxSourceNamespace> = {
  usb: 'pioneer-device-library',
  desktop: 'rekordbox-desktop-library'
}

export const resolveRekordboxSourceNamespace = (
  sourceKind: RekordboxSourceKind
): RekordboxSourceNamespace => REKORDBOX_SOURCE_NAMESPACE_MAP[sourceKind]

export const buildRekordboxSourceChannel = (
  sourceKind: RekordboxSourceKind,
  action: string
): string => `${resolveRekordboxSourceNamespace(sourceKind)}:${action}`

export const getRekordboxPreviewWaveformItemChannel = (sourceKind: RekordboxSourceKind): string =>
  buildRekordboxSourceChannel(sourceKind, 'preview-waveform-item')

export const getRekordboxPreviewWaveformDoneChannel = (sourceKind: RekordboxSourceKind): string =>
  buildRekordboxSourceChannel(sourceKind, 'preview-waveform-done')
