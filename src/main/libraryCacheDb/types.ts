import type { ISongInfo } from '../../types/globals'

export type SongCacheEntry = {
  size: number
  mtimeMs: number
  info: ISongInfo
}

export type CoverIndexEntry = {
  filePath: string
  hash: string
  ext: string
}

export type LegacyCacheRoots = {
  songRoots: Set<string>
  coverRoots: Set<string>
}
