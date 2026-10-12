import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import {
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2
} from '../../shared/songAnalysisCompleteness'

const SEARCH_EXTENDED_FIELD_LIMIT = 240
const SEARCH_EXTENDED_LYRICS_LIMIT = 800

const EXTENDED_SEARCH_FIELD_KEYS = [
  'albumArtist',
  'composer',
  'lyricist',
  'year',
  'trackNo',
  'trackTotal',
  'discNo',
  'discTotal',
  'isrc',
  'comment',
  'originalPlaylistPath',
  'recycleBinSourceType'
] as const

export type SongSearchPageSourceRow = {
  row_id: number
  list_root: string
  file_path: string
  info_json: string
}

export type ProjectedSongSearchRow = {
  rowId: number
  listRoot: string
  filePathColumn: string
  parsedFilePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  bitrate: string
  fileFormat: string
  container: string
  keyText: string
  bpm: number | null
  extendedText: string
}

const tryParseSongInfo = (raw: unknown): Partial<ISongInfo> | null => {
  if (raw === null || raw === undefined) return null
  try {
    return JSON.parse(String(raw)) as Partial<ISongInfo>
  } catch {
    return null
  }
}

const toSearchTextValue = (input: unknown, maxLength = SEARCH_EXTENDED_FIELD_LIMIT): string => {
  if (input === null || input === undefined) return ''
  if (Array.isArray(input)) {
    return input
      .map((item) => toSearchTextValue(item, maxLength))
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  if (typeof input === 'object') return ''
  const normalized = String(input).trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized
}

const collectExtendedSearchText = (rawInfo: Partial<ISongInfo> | null): string => {
  if (!rawInfo || typeof rawInfo !== 'object') return ''
  const record = rawInfo as Record<string, unknown>
  const terms: string[] = []
  for (const key of EXTENDED_SEARCH_FIELD_KEYS) {
    const text = toSearchTextValue(record[key])
    if (text) terms.push(text)
  }
  const lyrics = toSearchTextValue(record.lyrics, SEARCH_EXTENDED_LYRICS_LIMIT)
  if (lyrics) terms.push(lyrics)
  return terms.join(' ')
}

const fallbackFileFormat = (filePath: string): string => {
  const ext = path.extname(filePath)
  if (!ext) return ''
  return ext.slice(1).toUpperCase()
}

const textOrEmpty = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * 搜索索引只保留可检索字段。节拍网格、波形和结构留在 worker 里解析完就丢掉，
 * 不再把整份 info_json 送回主进程。
 */
export const projectSongSearchRow = (row: SongSearchPageSourceRow): ProjectedSongSearchRow => {
  const parsed = tryParseSongInfo(row.info_json)
  const filePathColumn = String(row.file_path || '').trim()
  const parsedFilePath = textOrEmpty(parsed?.filePath)
  const nameSource = parsedFilePath || filePathColumn
  const fileName = textOrEmpty(parsed?.fileName) || (nameSource ? path.basename(nameSource) : '')
  const fileFormat = textOrEmpty(parsed?.fileFormat) || fallbackFileFormat(nameSource)
  const title = textOrEmpty(parsed?.title) || fileName
  const container = textOrEmpty(parsed?.container) || fileFormat
  const bitrate =
    typeof parsed?.bitrate === 'number' && Number.isFinite(parsed.bitrate)
      ? String(parsed.bitrate)
      : ''
  const grid = resolveCanonicalSongBeatGridV2(parsed)
  return {
    rowId: Number(row.row_id) || 0,
    listRoot: String(row.list_root || ''),
    filePathColumn,
    parsedFilePath,
    fileName,
    title,
    artist: textOrEmpty(parsed?.artist),
    album: textOrEmpty(parsed?.album),
    genre: textOrEmpty(parsed?.genre),
    label: textOrEmpty(parsed?.label),
    duration: typeof parsed?.duration === 'string' ? parsed.duration : '',
    bitrate,
    fileFormat,
    container,
    keyText: hasUsableKeyAnalysis(parsed) ? textOrEmpty(parsed?.key) : '',
    bpm: grid.kind === 'grid' ? grid.bpm : null,
    extendedText: collectExtendedSearchText(parsed)
  }
}

export type SongSearchTermInput = {
  title: string
  artist: string
  album: string
  genre: string
  label: string
  fileName: string
  fileFormat: string
  container: string
  duration: string
  bitrate: string
  keyText: string
  bpm: number | null
  libraryName: string
  songListUUID: string
  songListName: string
  songListPath: string
  filePath: string
  extendedText: string
}

/** 候选过滤走这份全文。filePath 必须在里面，否则只能命中文件名、命不中目录。 */
export const collectSongSearchTerms = (
  input: SongSearchTermInput
): Array<string | number | null> => [
  input.title,
  input.artist,
  input.album,
  input.genre,
  input.label,
  input.fileName,
  input.fileFormat,
  input.container,
  input.duration,
  input.bitrate,
  input.keyText,
  input.bpm ?? '',
  input.libraryName,
  input.songListUUID,
  input.songListName,
  input.songListPath,
  input.filePath,
  input.extendedText
]
