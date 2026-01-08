import path from 'node:path'
import type { ISongInfo } from '../../types/globals'

export function buildLiteSongInfo(filePath: string): ISongInfo {
  const baseName = path.basename(filePath)
  const ext = path.extname(filePath)
  const fileFormat = ext ? ext.slice(1).toUpperCase() : ''
  return {
    filePath,
    fileName: baseName,
    fileFormat,
    cover: null,
    title: baseName,
    artist: undefined,
    album: undefined,
    duration: '',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: fileFormat || undefined,
    analysisOnly: true
  }
}

export function applyLiteDefaults(info: ISongInfo, filePath: string): ISongInfo {
  const baseName = path.basename(filePath)
  const ext = path.extname(filePath)
  const fileFormat = ext ? ext.slice(1).toUpperCase() : ''
  if (!info.fileName || info.fileName.trim() === '') info.fileName = baseName
  if (!info.fileFormat || info.fileFormat.trim() === '') info.fileFormat = fileFormat
  if (!info.title || info.title.trim() === '') info.title = baseName
  if (typeof info.container !== 'string' || info.container.trim() === '') {
    info.container = info.fileFormat || fileFormat || info.container
  }
  return info
}
