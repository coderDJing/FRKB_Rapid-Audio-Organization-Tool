import { computed } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import {
  getKeyDisplayText as formatKeyDisplayText,
  isHarmonicMixCompatible
} from '@shared/keyDisplay'
import { t } from '@renderer/utils/translate'
import { formatDeletedAtMs, getOriginalPlaylistDisplay } from '@renderer/utils/recycleBinDisplay'
import { formatBpmDisplay } from '@renderer/utils/bpm'

const normalizeArtistName = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()

export const useSongRowDisplay = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  sourceLibraryName: () => string
  harmonicReferenceKey: () => string
}) => {
  const { runtime, sourceLibraryName, harmonicReferenceKey } = params

  const getKeyDisplayText = (value: unknown): string => {
    const text = typeof value === 'string' ? value.trim() : ''
    const style = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
    const display = formatKeyDisplayText(text, style)
    if (display.toLowerCase() === 'o') {
      return t('player.keyDisplayNone')
    }
    return display
  }

  const getCellValue = (song: ISongInfo, colKey: string): string | number => {
    if (colKey === 'key') {
      return getKeyDisplayText(song.key)
    }
    if (colKey === 'deletedAtMs') {
      return formatDeletedAtMs(song.deletedAtMs)
    }
    if (colKey === 'originalPlaylistPath') {
      return getOriginalPlaylistDisplay(song)
    }
    const raw = song[colKey as keyof ISongInfo]
    if (colKey === 'bpm') {
      const bpm = Number(raw)
      return Number.isFinite(bpm) && bpm > 0 ? formatBpmDisplay(bpm, '') : ''
    }
    if (raw === undefined || raw === null) return ''
    return raw as string | number
  }

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

  const getCuratedArtistFavorite = (song: ISongInfo) =>
    curatedArtistFavoriteSet.value.get(normalizeArtistName(song.artist)) || null

  const isCuratedArtistHit = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'artist') return false
    if (sourceLibraryName() !== 'FilterLibrary') return false
    if (runtime.setting.enableCuratedArtistTracking === false) return false
    return curatedArtistFavoriteSet.value.has(normalizeArtistName(song.artist))
  }

  const getCuratedArtistBadgeText = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'artist') return ''
    const favorite = getCuratedArtistFavorite(song)
    if (!favorite) return ''
    return t('tracks.curatedArtistCountBadge', { count: favorite.count })
  }

  const getCuratedArtistBadgeTitle = (song: ISongInfo, colKey: string) => {
    if (colKey !== 'artist') return ''
    const favorite = getCuratedArtistFavorite(song)
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
    isCuratedArtistHit,
    getCuratedArtistBadgeText,
    getCuratedArtistBadgeTitle,
    isHarmonicKeyMatch
  }
}
