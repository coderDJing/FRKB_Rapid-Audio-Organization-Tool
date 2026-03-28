import type {
  PioneerPlaylistNodeRecord,
  PioneerPlaylistTrackLoadResult,
  PioneerPlaylistTrackRecordRaw,
  PioneerPlaylistTreeLoadResult
} from './types'

type SqliteDatabase = {
  pragma: (source: string, options?: { simple?: boolean }) => unknown
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Record<string, unknown>[]
    get: (...params: unknown[]) => Record<string, unknown> | undefined
  }
  close: () => void
}

type SqliteDatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }
) => SqliteDatabase

type PlaylistRow = {
  id?: number
  parentId?: number
  name?: string
  attribute?: number
  order?: number
}

type PlaylistTrackRow = {
  playlistId?: number
  trackId?: number
  entryIndex?: number
  title?: string
  artist?: string
  album?: string
  label?: string
  genre?: string
  filePath?: string
  fileName?: string
  keyText?: string
  bpmx100?: number
  durationSec?: number
  bitrate?: number
  sampleRate?: number
  sampleDepth?: number
  trackNumber?: number
  discNumber?: number
  year?: number
  analyzePath?: string
  comment?: string
  dateAdded?: string
  artworkId?: number
  artworkPath?: string
}

const ONE_LIBRARY_SQLITE_KEY = 'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls'

const escapePragmaString = (value: string) => String(value || '').replace(/'/g, "''")

const getSqliteDatabaseCtor = (): SqliteDatabaseCtor => {
  try {
    return require('better-sqlite3-multiple-ciphers') as SqliteDatabaseCtor
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || 'unknown error')
    throw new Error(`better-sqlite3-multiple-ciphers 不可用: ${detail}`)
  }
}

const verifyOneLibraryConnection = (db: SqliteDatabase) => {
  db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playlist' LIMIT 1"
  ).get()
}

const openOneLibraryDatabase = (databasePath: string): SqliteDatabase => {
  const Database = getSqliteDatabaseCtor()
  const attempts = [{ legacy: null }, { legacy: 4 }]
  let lastError: Error | null = null

  for (const attempt of attempts) {
    const db = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5000
    })

    try {
      db.pragma("cipher = 'sqlcipher'")
      if (attempt.legacy !== null) {
        db.pragma(`legacy = ${attempt.legacy}`)
      }
      db.pragma(`key = '${escapePragmaString(ONE_LIBRARY_SQLITE_KEY)}'`)
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      verifyOneLibraryConnection(db)
      return db
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || 'unknown error'))
      try {
        db.close()
      } catch {}
    }
  }

  throw new Error(lastError?.message || '无法打开 OneLibrary 数据库')
}

const toSafeNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const toOptionalNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const toSafeText = (value: unknown) => String(value || '').trim()

export function readOneLibraryPlaylistTree(databasePath: string): PioneerPlaylistTreeLoadResult {
  const db = openOneLibraryDatabase(databasePath)
  try {
    const rows = db
      .prepare(
        `
          SELECT
            p."playlist_id" AS id,
            p."playlist_id_parent" AS parentId,
            p."name" AS name,
            p."attribute" AS attribute,
            p."sequenceNo" AS "order"
          FROM "playlist" p
          ORDER BY p."sequenceNo", p."playlist_id"
        `
      )
      .all() as PlaylistRow[]

    const nodes: PioneerPlaylistNodeRecord[] = rows.map((row, index) => {
      const attribute = toSafeNumber(row?.attribute)
      return {
        id: toSafeNumber(row?.id),
        parentId: toSafeNumber(row?.parentId),
        name: toSafeText(row?.name),
        isFolder: attribute === 1,
        order: toSafeNumber(row?.order) || index
      }
    })

    return {
      databasePath,
      nodeTotal: nodes.length,
      folderTotal: nodes.filter((node) => node.isFolder).length,
      playlistTotal: nodes.filter((node) => !node.isFolder).length,
      nodes
    }
  } finally {
    db.close()
  }
}

export function readOneLibraryPlaylistTracks(
  databasePath: string,
  playlistId: number
): PioneerPlaylistTrackLoadResult {
  const db = openOneLibraryDatabase(databasePath)
  try {
    const playlistRow = db
      .prepare(
        `
          SELECT
            p."playlist_id" AS id,
            p."name" AS name
          FROM "playlist" p
          WHERE p."playlist_id" = ?
          LIMIT 1
        `
      )
      .get(playlistId) as { id?: number; name?: string } | undefined

    if (!playlistRow?.id) {
      throw new Error(`未找到 OneLibrary 歌单: ${playlistId}`)
    }

    const rows = db
      .prepare(
        `
          SELECT
            pc."playlist_id" AS playlistId,
            c."content_id" AS trackId,
            pc."sequenceNo" AS entryIndex,
            c."title" AS title,
            a."name" AS artist,
            al."name" AS album,
            lb."name" AS label,
            g."name" AS genre,
            c."path" AS filePath,
            c."fileName" AS fileName,
            k."name" AS keyText,
            c."bpmx100" AS bpmx100,
            c."length" AS durationSec,
            c."bitrate" AS bitrate,
            c."samplingRate" AS sampleRate,
            c."bitDepth" AS sampleDepth,
            c."trackNo" AS trackNumber,
            c."discNo" AS discNumber,
            c."releaseYear" AS year,
            c."analysisDataFilePath" AS analyzePath,
            c."djComment" AS comment,
            c."dateAdded" AS dateAdded,
            c."image_id" AS artworkId,
            i."path" AS artworkPath
          FROM "playlist_content" pc
          INNER JOIN "content" c ON c."content_id" = pc."content_id"
          LEFT JOIN "artist" a ON a."artist_id" = c."artist_id_artist"
          LEFT JOIN "album" al ON al."album_id" = c."album_id"
          LEFT JOIN "label" lb ON lb."label_id" = c."label_id"
          LEFT JOIN "genre" g ON g."genre_id" = c."genre_id"
          LEFT JOIN "key" k ON k."key_id" = c."key_id"
          LEFT JOIN "image" i ON i."image_id" = c."image_id"
          WHERE pc."playlist_id" = ?
          ORDER BY pc."sequenceNo", c."content_id"
        `
      )
      .all(playlistId) as PlaylistTrackRow[]

    const tracks: PioneerPlaylistTrackRecordRaw[] = rows.map((row) => ({
      playlistId: toSafeNumber(row?.playlistId) || playlistId,
      trackId: toSafeNumber(row?.trackId),
      entryIndex: toSafeNumber(row?.entryIndex),
      title: toSafeText(row?.title),
      artist: toSafeText(row?.artist),
      album: toSafeText(row?.album),
      label: toSafeText(row?.label),
      genre: toSafeText(row?.genre),
      filePath: toSafeText(row?.filePath),
      fileName: toSafeText(row?.fileName),
      keyText: toSafeText(row?.keyText),
      bpm:
        typeof row?.bpmx100 === 'number' && Number.isFinite(row.bpmx100)
          ? row.bpmx100 / 100
          : undefined,
      durationSec: toSafeNumber(row?.durationSec),
      bitrate: toOptionalNumber(row?.bitrate),
      sampleRate: toOptionalNumber(row?.sampleRate),
      sampleDepth: toOptionalNumber(row?.sampleDepth),
      trackNumber: toOptionalNumber(row?.trackNumber),
      discNumber: toOptionalNumber(row?.discNumber),
      year: toOptionalNumber(row?.year),
      analyzePath: toSafeText(row?.analyzePath),
      comment: toSafeText(row?.comment),
      dateAdded: toSafeText(row?.dateAdded),
      artworkId: toOptionalNumber(row?.artworkId),
      artworkPath: toSafeText(row?.artworkPath)
    }))

    return {
      databasePath,
      playlistId,
      playlistName: toSafeText(playlistRow?.name),
      trackTotal: tracks.length,
      tracks
    }
  } finally {
    db.close()
  }
}
