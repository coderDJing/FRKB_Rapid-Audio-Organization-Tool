import { computed } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'
import { normalizeArtistName, splitArtistNames } from '@shared/artistNames'
import { t } from '@renderer/utils/translate'
import {
  getSongListFieldDisplayTitle,
  getSongListFieldDisplayValue,
  resolveSongListKeyDisplayStyle
} from '@renderer/utils/songListFieldDisplay'

export const useSongRowDisplay = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  sourceLibraryName: () => string
  harmonicReferenceKey: () => string
}) => {
  const { runtime, sourceLibraryName, harmonicReferenceKey } = params
  const isDesktopRekordboxSong = (song: ISongInfo) =>
    sourceLibraryName() === 'PioneerDeviceLibrary' && song.externalSourceKind === 'desktop'

  const getFieldDisplayOptions = (song: ISongInfo) => ({
    keyDisplayStyle: resolveSongListKeyDisplayStyle(runtime.setting.keyDisplayStyle),
    isDesktopRekordboxSong: isDesktopRekordboxSong(song)
  })

  const getCellValue = (song: ISongInfo, colKey: string): string | number =>
    getSongListFieldDisplayValue(song, colKey, getFieldDisplayOptions(song))

  const getCellTitle = (song: ISongInfo, colKey: string): string =>
    getSongListFieldDisplayTitle(song, colKey, getFieldDisplayOptions(song))

  const curatedArtistFavoriteSet = computed(
    () =>
      new Map(
        (runtime.curatedArtistFavorites || [])
          .map((artist) => {
            const normalized = normalizeArtistName(artist?.name)
            if (!normalized) return null
            return [
              normalized,
              {
                name: String(artist?.name || '').trim(),
                count: Math.max(1, Math.round(Number(artist?.count) || 1))
              }
            ] as const
          })
          .filter((item): item is readonly [string, { name: string; count: number }] => !!item)
      )
  )

  const getCuratedArtistFavorites = (song: ISongInfo) =>
    splitArtistNames(song.artist)
      .map(
        (artistName) => curatedArtistFavoriteSet.value.get(normalizeArtistName(artistName)) || null
      )
      .filter((item): item is { name: string; count: number } => !!item)

  const isCuratedArtistHit = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'artist') return false
    if (sourceLibraryName() !== 'FilterLibrary') return false
    if (runtime.setting.enableCuratedArtistTracking === false) return false
    return getCuratedArtistFavorites(song).length > 0
  }

  const getCuratedArtistBadgeText = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'artist') return ''
    const favorites = getCuratedArtistFavorites(song)
    if (favorites.length > 1) {
      return t('tracks.curatedArtistMultiCountBadge', { count: favorites.length })
    }
    const favorite = favorites[0] || null
    if (!favorite) return ''
    return t('tracks.curatedArtistCountBadge', { count: favorite.count })
  }

  const getCuratedArtistBadgeTitle = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'artist') return ''
    const favorites = getCuratedArtistFavorites(song)
    if (favorites.length > 1) {
      return t('tracks.curatedArtistMultiCountBadgeTitle', {
        count: favorites.length,
        artists: favorites.map((item) => `${item.name} x ${item.count}`).join(' / ')
      })
    }
    const favorite = favorites[0] || null
    if (!favorite) return ''
    return t('tracks.curatedArtistCountBadgeTitle', {
      artist: favorite.name || String(song.artist || ''),
      count: favorite.count
    })
  }

  const isHarmonicKeyMatch = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'key') return false
    const referenceKey = String(harmonicReferenceKey() || '').trim()
    if (!referenceKey) return false
    return isHarmonicMixCompatible(referenceKey, String(song.key || '').trim())
  }

  return {
    getCellValue,
    getCellTitle,
    isCuratedArtistHit,
    getCuratedArtistBadgeText,
    getCuratedArtistBadgeTitle,
    isHarmonicKeyMatch
  }
}
