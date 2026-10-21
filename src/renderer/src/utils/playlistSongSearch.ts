import type { ISongInfo } from 'src/types/globals'
import { normalizePlaylistSearchText } from './playlistSearchText'
import {
  getSongListFieldDisplayValue,
  getSongListFieldRawValue,
  type SongListFieldDisplayOptions
} from './songListFieldDisplay'

// 只检索列表字段，不遍历封面、波形或分析对象等内部数据；隐藏列也参与匹配。
export const filterSongsByPlaylistSearch = (
  songs: ISongInfo[],
  query: string,
  columnKeys: string[],
  options: SongListFieldDisplayOptions
): ISongInfo[] => {
  const keyword = normalizePlaylistSearchText(query.trim())
  if (!keyword) return songs
  const keys = [...new Set([...columnKeys, 'filePath'])].filter(
    (key) => key !== 'cover' && key !== 'waveformPreview'
  )
  const matches = (value: unknown) =>
    (typeof value === 'string' || typeof value === 'number') &&
    normalizePlaylistSearchText(value).includes(keyword)

  return songs.filter((song, index) =>
    keys.some((key) => {
      if (key === 'index') {
        return matches(song.mixOrder || song.playlistTrackNumber || index + 1)
      }
      return (
        matches(getSongListFieldRawValue(song, key)) ||
        matches(getSongListFieldDisplayValue(song, key, options))
      )
    })
  )
}
