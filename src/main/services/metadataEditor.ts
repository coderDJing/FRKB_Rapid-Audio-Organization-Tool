import path = require('path')
import os = require('os')
import fs = require('fs-extra')
import child_process = require('child_process')
import { v4 as uuidV4 } from 'uuid'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import { ISongInfo, ITrackMetadataDetail, ITrackMetadataUpdatePayload } from '../../types/globals'
import { extFromMime } from './covers'

async function parseMetadata(filePath: string) {
  const mm = await import('music-metadata')
  return mm.parseFile(filePath)
}

function convertSecondsToMinutesSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  const minutesStr = minutes.toString().padStart(2, '0')
  const secondsStr = remainingSeconds.toString().padStart(2, '0')
  return `${minutesStr}:${secondsStr}`
}

function buildSongInfo(filePath: string, metadata: any): ISongInfo {
  const durationSeconds = metadata.format?.duration
  const duration =
    typeof durationSeconds === 'number' && durationSeconds >= 0
      ? convertSecondsToMinutesSeconds(Math.round(durationSeconds))
      : '00:00'

  return {
    filePath,
    cover: null,
    title:
      metadata.common?.title && metadata.common.title.trim() !== ''
        ? metadata.common.title
        : path.basename(filePath),
    artist: metadata.common?.artist,
    album: metadata.common?.album,
    duration,
    genre: Array.isArray(metadata.common?.genre)
      ? metadata.common.genre[0]
      : metadata.common?.genre,
    label: Array.isArray(metadata.common?.label)
      ? metadata.common.label[0]
      : metadata.common?.label,
    bitrate: metadata.format?.bitrate,
    container: metadata.format?.container
  }
}

function convertCoverToDataUrl(picture: any): { dataUrl: string; format?: string } | null {
  if (!picture || !picture.data) return null
  const mime = picture.format || 'image/jpeg'
  const buffer = Buffer.isBuffer(picture.data)
    ? picture.data
    : Array.isArray(picture.data)
      ? Buffer.from(picture.data)
      : Buffer.from(picture.data.data || [])
  if (!buffer.length) return null
  const base64 = buffer.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${base64}`,
    format: picture.format
  }
}

function buildDetail(filePath: string, metadata: any): ITrackMetadataDetail {
  const baseName = path.basename(filePath)
  const dotIndex = baseName.lastIndexOf('.')
  const nameWithoutExt = dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName
  const extension = dotIndex >= 0 ? baseName.slice(dotIndex) : ''
  const pictureSource = Array.isArray(metadata.common?.picture) ? metadata.common.picture[0] : null
  return {
    filePath,
    fileName: nameWithoutExt,
    fileExtension: extension,
    title: metadata.common?.title,
    artist: metadata.common?.artist,
    album: metadata.common?.album,
    albumArtist: metadata.common?.albumartist,
    trackNo: metadata.common?.track?.no ?? undefined,
    trackTotal: metadata.common?.track?.of ?? undefined,
    discNo: metadata.common?.disk?.no ?? undefined,
    discTotal: metadata.common?.disk?.of ?? undefined,
    year: metadata.common?.year ? String(metadata.common.year) : metadata.common?.date,
    genre: Array.isArray(metadata.common?.genre)
      ? metadata.common.genre[0]
      : metadata.common?.genre,
    composer: metadata.common?.composer,
    lyricist: metadata.common?.lyricist ?? metadata.common?.writer,
    label: Array.isArray(metadata.common?.label)
      ? metadata.common.label[0]
      : metadata.common?.label,
    isrc: metadata.common?.isrc,
    comment: Array.isArray(metadata.common?.comment)
      ? metadata.common.comment.filter((c: string) => c && c.trim() !== '')[0]
      : metadata.common?.comment,
    lyrics: Array.isArray(metadata.common?.lyrics)
      ? metadata.common.lyrics.join('\n')
      : metadata.common?.lyrics,
    cover: convertCoverToDataUrl(pictureSource)
  }
}

function sanitizeMetadataValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.replace(/\u0000/g, '').trim()
}

function buildFfmpegArgs(
  filePath: string,
  destPath: string,
  payload: ITrackMetadataUpdatePayload,
  coverPath?: string | null
) {
  const args: string[] = ['-y', '-i', filePath]
  if (coverPath) {
    args.push('-i', coverPath)
  }

  args.push('-map_metadata', '-1')
  args.push('-map', '0:a?')

  if (coverPath) {
    args.push('-map', '1:0')
  }

  args.push('-c:a', 'copy')

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') {
    args.push('-id3v2_version', '3')
  }
  if (ext === '.aif' || ext === '.aiff') {
    args.push('-write_id3v2', '1')
    args.push('-id3v2_version', '3')
  }

  if (coverPath) {
    args.push('-disposition:v:0', 'attached_pic')
    args.push('-metadata:s:v:0', 'title=Album cover')
    args.push('-metadata:s:v:0', 'comment=Cover (front)')
  }

  const entries: Array<[string, string | undefined]> = [
    ['title', sanitizeMetadataValue(payload.title)],
    ['artist', sanitizeMetadataValue(payload.artist)],
    ['album', sanitizeMetadataValue(payload.album)],
    ['album_artist', sanitizeMetadataValue(payload.albumArtist)],
    ['genre', sanitizeMetadataValue(payload.genre)],
    ['date', sanitizeMetadataValue(payload.year)],
    ['composer', sanitizeMetadataValue(payload.composer)],
    ['lyricist', sanitizeMetadataValue(payload.lyricist)],
    ['publisher', sanitizeMetadataValue(payload.label)],
    ['isrc', sanitizeMetadataValue(payload.isrc)],
    ['comment', sanitizeMetadataValue(payload.comment)],
    ['lyrics', sanitizeMetadataValue(payload.lyrics)]
  ]

  const trackParts: string[] = []
  if (typeof payload.trackNo === 'number' && payload.trackNo > 0) {
    trackParts.push(String(payload.trackNo))
  }
  if (typeof payload.trackTotal === 'number' && payload.trackTotal > 0) {
    if (!trackParts.length) trackParts.push('')
    trackParts[1] = String(payload.trackTotal)
  }
  if (trackParts.length) entries.push(['track', trackParts.join('/')])

  const discParts: string[] = []
  if (typeof payload.discNo === 'number' && payload.discNo > 0) {
    discParts.push(String(payload.discNo))
  }
  if (typeof payload.discTotal === 'number' && payload.discTotal > 0) {
    if (!discParts.length) discParts.push('')
    discParts[1] = String(payload.discTotal)
  }
  if (discParts.length) entries.push(['disc', discParts.join('/')])

  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') {
      args.push('-metadata', `${key}=${value}`)
    }
  }

  args.push(destPath)
  return args
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/)
  if (!match) {
    throw new Error('Invalid data URL')
  }
  const mime = match[1] || 'image/jpeg'
  const base64 = match[2]
  return { buffer: Buffer.from(base64, 'base64'), mime }
}

async function writeTempFile(buffer: Buffer, extension: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-meta-'))
  const target = path.join(dir, `${uuidV4()}${extension}`)
  await fs.outputFile(target, buffer)
  return target
}

export async function readTrackMetadata(filePath: string): Promise<ITrackMetadataDetail | null> {
  try {
    const metadata = await parseMetadata(filePath)
    return buildDetail(filePath, metadata)
  } catch {
    return null
  }
}

export async function updateTrackMetadata(
  payload: ITrackMetadataUpdatePayload
): Promise<{ songInfo: ISongInfo; detail: ITrackMetadataDetail; renamedFrom?: string }> {
  let filePath = payload.filePath
  const originalFilePath = filePath
  const ext = path.extname(filePath)
  const ffmpegPath = resolveBundledFfmpegPath()
  await ensureExecutableOnMac(ffmpegPath)

  const tempOutput = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, ext)}.metadata-edit.${uuidV4()}${ext}`
  )

  let coverTempPath: string | null = null
  let originalMetadata: any = null
  try {
    try {
      originalMetadata = await parseMetadata(filePath)
    } catch {
      originalMetadata = null
    }
    const newBaseName = typeof payload.newBaseName === 'string' ? payload.newBaseName.trim() : ''
    if (newBaseName && newBaseName !== path.basename(filePath, ext)) {
      const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
      if (invalidCharsRegex.test(newBaseName)) {
        throw new Error('INVALID_FILE_NAME')
      }
      if (newBaseName === '.' || newBaseName === '..' || /[ .]$/.test(newBaseName)) {
        throw new Error('INVALID_FILE_NAME')
      }
      const dir = path.dirname(filePath)
      const targetPath = path.join(dir, `${newBaseName}${ext}`)
      const exists = await fs.pathExists(targetPath)
      if (exists) {
        throw new Error('FILE_NAME_EXISTS')
      }
      await fs.rename(filePath, targetPath)
      filePath = targetPath
      payload.filePath = targetPath
    }

    if (payload.coverDataUrl) {
      const { buffer, mime } = dataUrlToBuffer(payload.coverDataUrl)
      const extension = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg'
      coverTempPath = await writeTempFile(buffer, extension)
    }

    const args = buildFfmpegArgs(filePath, tempOutput, payload, coverTempPath)
    await new Promise<void>((resolve, reject) => {
      const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exit ${code}`))
      })
    })

    await fs.move(tempOutput, filePath, { overwrite: true })

    // 如果没有提供新的封面但原文件包含封面，尝试从备份恢复
    if (!payload.coverDataUrl && originalMetadata) {
      try {
        const originalCover = (await import('music-metadata')).selectCover(
          originalMetadata.common?.picture
        )
        const currentMetadata = await parseMetadata(filePath)
        const currentCover = (await import('music-metadata')).selectCover(
          currentMetadata.common?.picture
        )

        if (originalCover && !currentCover) {
          const coverBuffer = Buffer.isBuffer(originalCover.data)
            ? originalCover.data
            : Array.isArray(originalCover.data)
              ? Buffer.from(originalCover.data)
              : Buffer.from((originalCover.data as any)?.data || [])
          if (coverBuffer.length > 0) {
            const coverMime = originalCover.format || 'image/jpeg'
            const extension = extFromMime(coverMime)
            coverTempPath = await writeTempFile(coverBuffer, extension)
            const patchOutput = path.join(
              path.dirname(filePath),
              `.${path.basename(filePath, ext)}.metadata-cover.${uuidV4()}${ext}`
            )
            try {
              const patchArgs = buildFfmpegArgs(
                filePath,
                patchOutput,
                {
                  ...payload,
                  coverDataUrl: undefined
                },
                coverTempPath
              )
              await new Promise<void>((resolve, reject) => {
                const child = child_process.spawn(ffmpegPath, patchArgs, { windowsHide: true })
                child.on('error', reject)
                child.on('exit', (code) => {
                  if (code === 0) resolve()
                  else reject(new Error(`ffmpeg exit ${code}`))
                })
              })
              await fs.move(patchOutput, filePath, { overwrite: true })
            } catch {
            } finally {
              try {
                if (await fs.pathExists(patchOutput)) {
                  await fs.remove(patchOutput)
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    const metadata = await parseMetadata(filePath)
    return {
      songInfo: buildSongInfo(filePath, metadata),
      detail: buildDetail(filePath, metadata),
      renamedFrom: originalFilePath === filePath ? undefined : originalFilePath
    }
  } finally {
    try {
      if (coverTempPath) {
        const coverDir = path.dirname(coverTempPath)
        if (await fs.pathExists(coverDir)) {
          await fs.remove(coverDir)
        }
      }
    } catch {}
    try {
      if (await fs.pathExists(tempOutput)) {
        await fs.remove(tempOutput)
      }
    } catch {}
  }
}

export default {
  readTrackMetadata,
  updateTrackMetadata
}
