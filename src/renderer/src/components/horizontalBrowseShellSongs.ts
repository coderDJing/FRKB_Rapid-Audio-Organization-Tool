import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import { areSongHotCuesEqual, normalizeSongHotCues } from '@shared/hotCues'
import { areSongMemoryCuesEqual, normalizeSongMemoryCues } from '@shared/memoryCues'

type SharedSongGridPayload = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
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
    typeof payload.bpm === 'number' &&
    Number.isFinite(payload.bpm) &&
    nextSong.bpm !== payload.bpm
  ) {
    nextSong.bpm = payload.bpm
    touched = true
  }
  if (
    typeof payload.firstBeatMs === 'number' &&
    Number.isFinite(payload.firstBeatMs) &&
    nextSong.firstBeatMs !== payload.firstBeatMs
  ) {
    nextSong.firstBeatMs = payload.firstBeatMs
    touched = true
  }
  if (
    typeof payload.barBeatOffset === 'number' &&
    Number.isFinite(payload.barBeatOffset) &&
    nextSong.barBeatOffset !== payload.barBeatOffset
  ) {
    nextSong.barBeatOffset = payload.barBeatOffset
    touched = true
  }
  return touched ? nextSong : song
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
