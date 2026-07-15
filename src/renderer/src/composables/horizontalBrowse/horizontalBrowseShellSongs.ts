import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import { areSongHotCuesEqual, normalizeSongHotCues } from '@shared/hotCues'
import { areSongMemoryCuesEqual, normalizeSongMemoryCues } from '@shared/memoryCues'
import { normalizeSongStructureAnalysis, type SongStructureAnalysis } from '@shared/songStructure'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

type SharedSongGridPayload = {
  filePath?: string
  timeBasisOffsetMs?: number
  beatGridMap?: ISongInfo['beatGridMap'] | null
  songStructure?: SongStructureAnalysis
} | null

export const isSameHorizontalBrowseSongFilePath = (left: unknown, right: unknown) => {
  const normalize = (value: unknown) => {
    const normalized = String(value || '')
      .trim()
      .replace(/\//g, '\\')
    if (!normalized) return ''
    return /win/i.test(navigator.platform) ? normalized.toLowerCase() : normalized
  }
  const leftPath = normalize(left)
  const rightPath = normalize(right)
  return !!leftPath && leftPath === rightPath
}

export const buildHorizontalBrowseSongSnapshot = (filePath: string): ISongInfo => {
  const normalizedPath = String(filePath || '').trim()
  const fileName = normalizedPath.split(/[/\\]/).pop() || ''
  const parts = fileName.split('.')
  const extension = parts.length > 1 ? parts.pop() || '' : ''

  return {
    filePath: normalizedPath,
    fileName,
    fileFormat: extension.toUpperCase(),
    cover: null,
    title: fileName,
    artist: '',
    album: '',
    duration: '',
    genre: '',
    label: '',
    bitrate: undefined,
    container: undefined
  }
}

export const mergeHorizontalBrowseSongWithSharedGrid = (
  song: ISongInfo,
  payload: SharedSongGridPayload
): ISongInfo => {
  if (!payload) return song
  const filePath = String(payload.filePath || '').trim()
  if (!filePath || !isSameHorizontalBrowseSongFilePath(filePath, song.filePath)) return song

  let touched = false
  const nextSong: ISongInfo = { ...song }
  if (
    typeof payload.timeBasisOffsetMs === 'number' &&
    Number.isFinite(payload.timeBasisOffsetMs) &&
    nextSong.timeBasisOffsetMs !== payload.timeBasisOffsetMs
  ) {
    nextSong.timeBasisOffsetMs = payload.timeBasisOffsetMs
    touched = true
  }
  if (payload.beatGridMap !== undefined) {
    const beatGridMap = normalizeSongBeatGridMapV2(payload.beatGridMap, {
      allowSingleClip: true
    })
    if (beatGridMap) {
      if (
        JSON.stringify(
          normalizeSongBeatGridMapV2(nextSong.beatGridMap, { allowSingleClip: true })
        ) !== JSON.stringify(beatGridMap)
      ) {
        nextSong.beatGridMap = beatGridMap
        touched = true
      }
    } else if (nextSong.beatGridMap !== undefined) {
      delete nextSong.beatGridMap
      touched = true
    }
  }
  const songStructure = normalizeSongStructureAnalysis(payload.songStructure)
  if (songStructure) {
    nextSong.songStructure = songStructure
    touched = true
  }
  return touched ? nextSong : song
}

export const mergeHorizontalBrowseSongWithStructure = (
  song: ISongInfo,
  payload: { filePath?: string; songStructure?: SongStructureAnalysis } | null
): ISongInfo => {
  if (!payload) return song
  const filePath = String(payload.filePath || '').trim()
  if (!filePath || !isSameHorizontalBrowseSongFilePath(filePath, song.filePath)) return song
  const songStructure = normalizeSongStructureAnalysis(payload.songStructure)
  if (!songStructure) return song
  if (
    JSON.stringify(normalizeSongStructureAnalysis(song.songStructure)) ===
    JSON.stringify(songStructure)
  ) {
    return song
  }
  return {
    ...song,
    songStructure
  }
}

export const mergeHorizontalBrowseSongWithHotCues = (
  song: ISongInfo,
  payload: { filePath?: string; hotCues?: ISongHotCue[] } | null
): ISongInfo => {
  if (!payload) return song
  const filePath = String(payload.filePath || '').trim()
  if (!filePath || !isSameHorizontalBrowseSongFilePath(filePath, song.filePath)) return song
  const normalizedHotCues = normalizeSongHotCues(payload.hotCues)
  if (areSongHotCuesEqual(song.hotCues, normalizedHotCues)) return song
  return {
    ...song,
    hotCues: normalizedHotCues
  }
}

export const mergeHorizontalBrowseSongWithMemoryCues = (
  song: ISongInfo,
  payload: { filePath?: string; memoryCues?: ISongMemoryCue[] } | null
): ISongInfo => {
  if (!payload) return song
  const filePath = String(payload.filePath || '').trim()
  if (!filePath || !isSameHorizontalBrowseSongFilePath(filePath, song.filePath)) return song
  const normalizedMemoryCues = normalizeSongMemoryCues(payload.memoryCues)
  if (areSongMemoryCuesEqual(song.memoryCues, normalizedMemoryCues)) return song
  return {
    ...song,
    memoryCues: normalizedMemoryCues
  }
}
