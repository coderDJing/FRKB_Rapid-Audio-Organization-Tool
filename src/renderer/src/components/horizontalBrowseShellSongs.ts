import type { ISongInfo } from 'src/types/globals'

type SharedSongGridPayload = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
} | null

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
  if (!filePath || filePath !== song.filePath) return song

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
