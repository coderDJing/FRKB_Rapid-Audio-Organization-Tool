import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { RekordboxXmlExportStagedTrack } from './types'

const escapeXmlAttribute = (value: string) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

const quoteRekordboxPath = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/')
    .replace(/%5C/gi, '\\')

const toRekordboxLocation = (absolutePath: string) => {
  const resolved = path.resolve(absolutePath)
  const encodedPath = quoteRekordboxPath(resolved).replace(/\\/g, '/')
  const prefix =
    process.platform === 'win32'
      ? `file://localhost/${encodedPath}`
      : `file://localhost${encodedPath.startsWith('/') ? '' : '/'}${encodedPath}`
  return prefix
}

const resolveTrackKind = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') return 'MP3 File'
  if (ext === '.wav') return 'WAV File'
  if (ext === '.flac') return 'FLAC File'
  if (ext === '.aif' || ext === '.aiff') return 'AIFF File'
  if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return 'AAC File'
  if (ext === '.ogg') return 'Ogg Vorbis File'
  return `${ext.replace(/^\./, '').toUpperCase() || 'Audio'} File`
}

const resolveTrackSize = (filePath: string) => {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

const parseDurationSeconds = (value: string | undefined) => {
  const text = String(value || '').trim()
  if (!text) return 0
  const parts = text.split(':').map((part) => Number(part))
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part) || part < 0)) return 0
  return parts[0] * 60 + parts[1]
}

const normalizeBitRateKbps = (value: number | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1000) return Math.round(value / 1000)
  return Math.round(value)
}

const normalizePositiveInteger = (value: number | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

const normalizeYearValue = (value: string | undefined) => {
  const text = String(value || '').trim()
  if (!text) return undefined
  const matched = text.match(/\d{4}/)
  return matched ? matched[0] : undefined
}

const pushTrackAttribute = (pairs: string[], key: string, value: string | number | undefined) => {
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    if (!value.trim()) return
    pairs.push(`${key}="${escapeXmlAttribute(value)}"`)
    return
  }
  pairs.push(`${key}="${value}"`)
}

export const buildRekordboxXml = (params: {
  playlistName: string
  tracks: RekordboxXmlExportStagedTrack[]
}) => {
  const { playlistName, tracks } = params
  const appVersion = (() => {
    try {
      return app.getVersion()
    } catch {
      return 'unknown'
    }
  })()

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<DJ_PLAYLISTS Version="1.0.0">')
  lines.push(`  <PRODUCT Name="FRKB" Version="${escapeXmlAttribute(appVersion)}" Company="FRKB" />`)
  lines.push(`  <COLLECTION Entries="${tracks.length}">`)
  for (const track of tracks) {
    const resolvedName =
      track.displayName || path.basename(track.outputPath, path.extname(track.outputPath))
    const trackKind = resolveTrackKind(track.outputPath)
    const trackSize = resolveTrackSize(track.outputPath)
    const attrs: string[] = []
    pushTrackAttribute(attrs, 'TrackID', track.trackId)
    pushTrackAttribute(attrs, 'Name', resolvedName)
    pushTrackAttribute(attrs, 'Artist', track.artist)
    pushTrackAttribute(attrs, 'Composer', track.composer)
    pushTrackAttribute(attrs, 'Album', track.album)
    pushTrackAttribute(attrs, 'Genre', track.genre)
    pushTrackAttribute(attrs, 'Label', track.label)
    pushTrackAttribute(attrs, 'Kind', trackKind)
    pushTrackAttribute(attrs, 'Size', trackSize)
    pushTrackAttribute(attrs, 'TotalTime', parseDurationSeconds(track.duration))
    pushTrackAttribute(attrs, 'DiscNumber', normalizePositiveInteger(track.discNumber))
    pushTrackAttribute(attrs, 'TrackNumber', normalizePositiveInteger(track.trackNumber))
    pushTrackAttribute(attrs, 'Year', normalizeYearValue(track.year))
    pushTrackAttribute(attrs, 'BitRate', normalizeBitRateKbps(track.bitrate))
    pushTrackAttribute(attrs, 'Comments', track.comment)
    pushTrackAttribute(attrs, 'Location', toRekordboxLocation(track.outputPath))
    lines.push(`    <TRACK ${attrs.join(' ')} />`)
  }
  lines.push('  </COLLECTION>')
  lines.push('  <PLAYLISTS>')
  lines.push('    <NODE Type="0" Name="ROOT" Count="1">')
  lines.push(
    `      <NODE Name="${escapeXmlAttribute(playlistName)}" Type="1" KeyType="0" Entries="${tracks.length}">`
  )
  for (const track of tracks) {
    lines.push(`        <TRACK Key="${track.trackId}" />`)
  }
  lines.push('      </NODE>')
  lines.push('    </NODE>')
  lines.push('  </PLAYLISTS>')
  lines.push('</DJ_PLAYLISTS>')
  lines.push('')
  return lines.join('\n')
}
