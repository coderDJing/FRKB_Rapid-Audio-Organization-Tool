export const BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY = 'bpmKey' as const

export const BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_KEYS = [
  'title',
  'artist',
  'duration',
  'bpm',
  'energyScore',
  'key',
  'album',
  'label',
  'genre',
  'fileFormat',
  'bitrate',
  'fileName',
  'container'
] as const

export const BROWSER_PLAYER_RIGHT_TRACK_INFO_FIELDS = [
  BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY,
  ...BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_KEYS
] as const

export type BrowserPlayerRightTrackInfoField =
  (typeof BROWSER_PLAYER_RIGHT_TRACK_INFO_FIELDS)[number]

export type BrowserPlayerRightTrackInfoColumnKey =
  (typeof BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_KEYS)[number]

export const BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_LABEL_KEYS: Record<
  BrowserPlayerRightTrackInfoColumnKey,
  string
> = {
  title: 'columns.title',
  artist: 'columns.artist',
  duration: 'columns.duration',
  bpm: 'columns.bpm',
  energyScore: 'columns.energy',
  key: 'columns.key',
  album: 'columns.album',
  label: 'columns.label',
  genre: 'columns.genre',
  fileFormat: 'columns.fileFormat',
  bitrate: 'columns.bitrate',
  fileName: 'columns.fileName',
  container: 'columns.format'
}

export const DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO: BrowserPlayerRightTrackInfoField =
  BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY

const FIELD_SET = new Set<string>(BROWSER_PLAYER_RIGHT_TRACK_INFO_FIELDS)

export const isBrowserPlayerRightTrackInfoField = (
  value: unknown
): value is BrowserPlayerRightTrackInfoField => typeof value === 'string' && FIELD_SET.has(value)

export const normalizeBrowserPlayerRightTrackInfo = (
  value: unknown
): BrowserPlayerRightTrackInfoField =>
  isBrowserPlayerRightTrackInfoField(value) ? value : DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO

export const canTapBrowserPlayerRightTrackInfo = (value: unknown) => {
  const field = normalizeBrowserPlayerRightTrackInfo(value)
  return field === BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY || field === 'bpm'
}
