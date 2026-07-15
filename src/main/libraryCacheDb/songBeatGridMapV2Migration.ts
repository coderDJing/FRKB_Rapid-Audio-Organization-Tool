import {
  createSongBeatGridMapFromFixedGrid,
  normalizeSongBeatGridMap
} from '../../shared/songBeatGridMap'
import {
  createSongBeatGridMapV2FromClips,
  type SongBeatGridMapV2,
  type SongBeatGridV2Source
} from '../../shared/songBeatGridMapV2'

type SongInfoRecord = Record<string, unknown>

export type SongBeatGridMapV2MigrationOutcome = 'migrated' | 'no-grid' | 'invalid-grid'

export type SongBeatGridMapV2MigrationResult = {
  info: SongInfoRecord
  outcome: SongBeatGridMapV2MigrationOutcome
  map?: SongBeatGridMapV2
}

const LEGACY_GRID_FIELDS = [
  'bpm',
  'firstBeatMs',
  'barBeatOffset',
  'beatGridSource',
  'beatGridStatus',
  'beatGridMap',
  'beatGridAlgorithmVersion'
] as const

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const hasLegacyGrid = (info: SongInfoRecord): boolean =>
  LEGACY_GRID_FIELDS.some((field) => hasOwn(info, field) && info[field] !== undefined)

const toDownbeatBeatOffset = (value: number): number => ((value % 4) + 4) % 4

const resolveSource = (value: unknown): SongBeatGridV2Source =>
  value === 'manual' ? 'manual' : 'analysis'

const removeLegacyGridFields = (info: SongInfoRecord): SongInfoRecord => {
  const next = { ...info }
  for (const field of LEGACY_GRID_FIELDS) delete next[field]
  return next
}

const resolveLegacyMap = (info: SongInfoRecord) => {
  const explicitMap = normalizeSongBeatGridMap(info.beatGridMap, { allowSingleClip: true })
  if (explicitMap) return explicitMap
  return createSongBeatGridMapFromFixedGrid({
    bpm: info.bpm,
    firstBeatMs: info.firstBeatMs,
    barBeatOffset: info.barBeatOffset
  })
}

export const migrateSongInfoBeatGridMapV2 = (value: unknown): SongBeatGridMapV2MigrationResult => {
  const info: SongInfoRecord =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as SongInfoRecord) }
      : {}
  const legacyMap = resolveLegacyMap(info)
  if (!legacyMap) {
    return {
      info: hasLegacyGrid(info) ? removeLegacyGridFields(info) : info,
      outcome: hasLegacyGrid(info) ? 'invalid-grid' : 'no-grid'
    }
  }
  const source = resolveSource(info.beatGridSource || legacyMap.source)
  const map = createSongBeatGridMapV2FromClips(
    legacyMap.clips.map((clip) => ({
      startSec: clip.startSec,
      anchorSec: clip.anchorSec,
      bpm: clip.bpm,
      downbeatBeatOffset: toDownbeatBeatOffset(clip.barBeatOffset)
    })),
    source,
    { allowSingleClip: true }
  )
  if (!map) {
    return { info: removeLegacyGridFields(info), outcome: 'invalid-grid' }
  }
  const next = removeLegacyGridFields(info)
  next.beatGridMap = map
  return { info: next, outcome: 'migrated', map }
}
