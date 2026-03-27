import path from 'node:path'
import { log } from '../../log'
import { probePioneerDeviceLibraryRoot } from './deviceDetection'
import { readPioneerPlaylistTracksInWorker, readPioneerPlaylistTreeInWorker } from './workerPool'
import type { IPioneerPlaylistTrack, IPioneerPlaylistTreeNode } from '../../../types/globals'

type RustPioneerPlaylistTreeNode = {
  id: number
  parentId?: number
  parent_id?: number
  name: string
  isFolder?: boolean
  is_folder?: boolean
  order: number
}

type RustPioneerPlaylistTreeDump = {
  exportPdbPath: string
  export_pdb_path?: string
  nodeTotal?: number
  node_total?: number
  folderTotal?: number
  folder_total?: number
  playlistTotal?: number
  playlist_total?: number
  nodes?: RustPioneerPlaylistTreeNode[]
  error?: string
}

type RustPioneerPlaylistTrackRecord = {
  playlistId?: number
  playlist_id?: number
  trackId?: number
  track_id?: number
  entryIndex?: number
  entry_index?: number
  title?: string
  artist?: string
  album?: string
  label?: string
  genre?: string
  filePath?: string
  file_path?: string
  fileName?: string
  file_name?: string
  keyText?: string
  key_text?: string
  bpm?: number
  durationSec?: number
  duration_sec?: number
  bitrate?: number
  sampleRate?: number
  sample_rate?: number
  sampleDepth?: number
  sample_depth?: number
  trackNumber?: number
  track_number?: number
  discNumber?: number
  disc_number?: number
  year?: number
  analyzePath?: string
  analyze_path?: string
  comment?: string
  dateAdded?: string
  date_added?: string
  artworkId?: number
  artwork_id?: number
  artworkPath?: string
  artwork_path?: string
}

type RustPioneerPlaylistTrackDump = {
  exportPdbPath?: string
  export_pdb_path?: string
  playlistId?: number
  playlist_id?: number
  playlistName?: string
  playlist_name?: string
  trackTotal?: number
  track_total?: number
  tracks?: RustPioneerPlaylistTrackRecord[]
  error?: string
}

export async function loadPioneerPlaylistTreeByDrivePath(rootPath: string): Promise<{
  drivePath: string
  driveName: string
  exportPdbPath: string
  nodeTotal: number
  folderTotal: number
  playlistTotal: number
  nodes: IPioneerPlaylistTreeNode[]
}> {
  const probe = await probePioneerDeviceLibraryRoot(rootPath)
  if (!probe.hasExportPdb || !probe.exportPdbPath) {
    throw new Error('未找到 Pioneer Device Library 的 export.pdb')
  }

  const result = await readPioneerPlaylistTreeInWorker<RustPioneerPlaylistTreeDump>(
    probe.exportPdbPath
  )
  if (result?.error) {
    throw new Error(String(result.error))
  }

  const rawNodes = Array.isArray(result?.nodes) ? result.nodes : []
  const nodes = rawNodes.map((node) => ({
    id: Number(node?.id) || 0,
    parentId: Number(node?.parentId ?? node?.parent_id) || 0,
    name: String(node?.name || '').trim(),
    isFolder: Boolean(node?.isFolder ?? node?.is_folder),
    order: Number(node?.order) || 0
  }))

  return {
    drivePath: rootPath,
    driveName: '',
    exportPdbPath: String(result?.exportPdbPath ?? result?.export_pdb_path ?? probe.exportPdbPath),
    nodeTotal: Number(result?.nodeTotal ?? result?.node_total) || nodes.length,
    folderTotal: Number(result?.folderTotal ?? result?.folder_total) || 0,
    playlistTotal: Number(result?.playlistTotal ?? result?.playlist_total) || 0,
    nodes
  }
}

export function buildPioneerPlaylistTree(
  nodes: IPioneerPlaylistTreeNode[]
): IPioneerPlaylistTreeNode[] {
  const normalized = Array.isArray(nodes)
    ? nodes
        .filter((node) => node && typeof node.name === 'string' && node.name.trim().length > 0)
        .map((node) => ({
          id: Number(node.id) || 0,
          parentId: Number(node.parentId) || 0,
          name: String(node.name || '').trim(),
          isFolder: Boolean(node.isFolder),
          order: Number(node.order) || 0,
          children: [] as IPioneerPlaylistTreeNode[]
        }))
    : []

  const byId = new Map<number, IPioneerPlaylistTreeNode>()
  for (const node of normalized) {
    byId.set(node.id, node)
  }

  const roots: IPioneerPlaylistTreeNode[] = []
  for (const node of normalized) {
    const parent = byId.get(node.parentId)
    if (parent) {
      parent.children = parent.children || []
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortRecursive = (items: IPioneerPlaylistTreeNode[]) => {
    items.sort((left, right) => {
      if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1
      return left.order - right.order
    })
    for (const item of items) {
      if (Array.isArray(item.children) && item.children.length > 0) {
        sortRecursive(item.children)
      }
    }
  }

  sortRecursive(roots)
  return roots
}

export async function debugWritePioneerPlaylistTreeLog(rootPath: string): Promise<void> {
  try {
    const loaded = await loadPioneerPlaylistTreeByDrivePath(rootPath)
    log.info('[pioneer-device-library] playlist tree loaded', {
      drivePath: rootPath,
      exportPdbPath: loaded.exportPdbPath,
      nodeTotal: loaded.nodeTotal,
      folderTotal: loaded.folderTotal,
      playlistTotal: loaded.playlistTotal
    })
  } catch (error) {
    log.error('[pioneer-device-library] playlist tree load failed', { rootPath, error })
  }
}

const formatDuration = (durationSec: number) => {
  const safe = Math.max(0, Number(durationSec) || 0)
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const deriveFileFormat = (fileName: string, filePath: string) => {
  const source = String(fileName || filePath || '').trim()
  const ext = source.includes('.') ? source.split('.').pop() || '' : ''
  return ext.trim().toUpperCase()
}

const resolvePioneerDevicePath = (rootPath: string, devicePath: string) => {
  const normalizedRoot = String(rootPath || '').trim()
  const normalizedDevicePath = String(devicePath || '').trim()
  if (!normalizedRoot || !normalizedDevicePath) return ''
  const sanitized = normalizedDevicePath.replace(/^[/\\]+/, '')
  return path.join(normalizedRoot, sanitized)
}

const deriveArtistFromFileName = (fileName: string) => {
  const normalized = String(fileName || '').trim()
  if (!normalized) return ''
  const ext = normalized.includes('.') ? normalized.replace(/\.[^.]+$/, '') : normalized
  const separatorIndex = ext.indexOf(' - ')
  if (separatorIndex <= 0) return ''
  return ext.slice(0, separatorIndex).trim()
}

const deriveArtistFromFilePath = (filePath: string, album: string) => {
  const normalized = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
  if (!normalized) return ''
  const contentsIndex = normalized.toLowerCase().indexOf('/contents/')
  const relative =
    contentsIndex >= 0 ? normalized.slice(contentsIndex + '/Contents/'.length) : normalized
  const segments = relative.split('/').filter(Boolean)
  if (segments.length < 2) return ''
  const artistFolder = String(segments[0] || '').trim()
  if (!artistFolder) return ''
  if (album && artistFolder.toLowerCase() === album.toLowerCase()) return ''
  return artistFolder.replace(/_/g, ', ').trim()
}

const resolvePioneerArtistText = (params: {
  mappedArtist: string
  fileName: string
  filePath: string
  album: string
}) => {
  const mapped = String(params.mappedArtist || '').trim()
  if (mapped) return mapped
  const fromFileName = deriveArtistFromFileName(params.fileName)
  if (fromFileName) return fromFileName
  const fromFilePath = deriveArtistFromFilePath(params.filePath, params.album)
  if (fromFilePath) return fromFilePath
  return ''
}

export async function loadPioneerPlaylistTracksByDrivePath(
  rootPath: string,
  playlistId: number
): Promise<{
  drivePath: string
  exportPdbPath: string
  playlistId: number
  playlistName: string
  trackTotal: number
  tracks: IPioneerPlaylistTrack[]
}> {
  const probe = await probePioneerDeviceLibraryRoot(rootPath)
  if (!probe.hasExportPdb || !probe.exportPdbPath) {
    throw new Error('未找到 Pioneer Device Library 的 export.pdb')
  }
  const safePlaylistId = Number(playlistId) || 0
  if (safePlaylistId <= 0) {
    throw new Error('playlistId 无效')
  }

  const result = await readPioneerPlaylistTracksInWorker<RustPioneerPlaylistTrackDump>(
    probe.exportPdbPath,
    safePlaylistId
  )
  if (result?.error) {
    throw new Error(String(result.error))
  }

  const playlistName = String(result?.playlistName ?? result?.playlist_name ?? '').trim()
  const rawTracks = Array.isArray(result?.tracks) ? result.tracks : []
  const tracks: IPioneerPlaylistTrack[] = rawTracks.map((track) => {
    const playlistIdValue = Number(track?.playlistId ?? track?.playlist_id) || safePlaylistId
    const trackIdValue = Number(track?.trackId ?? track?.track_id) || 0
    const entryIndexValue = Number(track?.entryIndex ?? track?.entry_index) || 0
    const deviceRelativeFilePath = String(track?.filePath ?? track?.file_path ?? '').trim()
    const filePath = resolvePioneerDevicePath(rootPath, deviceRelativeFilePath)
    const fileName = String(track?.fileName ?? track?.file_name ?? '').trim()
    const fileFormat = deriveFileFormat(fileName, deviceRelativeFilePath || filePath)
    const durationSec = Number(track?.durationSec ?? track?.duration_sec) || 0
    const artworkPath = String(track?.artworkPath ?? track?.artwork_path ?? '').trim()
    const coverPath = artworkPath ? resolvePioneerDevicePath(rootPath, artworkPath) : ''
    const albumText = String(track?.album || '').trim()
    const mappedArtist = String(track?.artist || '').trim()
    const resolvedArtist = resolvePioneerArtistText({
      mappedArtist,
      fileName,
      filePath: deviceRelativeFilePath || filePath,
      album: albumText
    })
    return {
      rowKey: `pioneer:${playlistIdValue}:${entryIndexValue}:${trackIdValue}`,
      playlistId: playlistIdValue,
      playlistName,
      trackId: trackIdValue,
      entryIndex: entryIndexValue,
      title: String(track?.title || '').trim(),
      artist: resolvedArtist,
      album: albumText,
      label: String(track?.label || '').trim(),
      genre: String(track?.genre || '').trim(),
      filePath,
      fileName,
      fileFormat,
      container: fileFormat,
      duration: formatDuration(durationSec),
      durationSec,
      bpm: Number(track?.bpm) || undefined,
      key: String(track?.keyText ?? track?.key_text ?? '').trim() || undefined,
      bitrate: Number(track?.bitrate) || undefined,
      sampleRate: Number(track?.sampleRate ?? track?.sample_rate) || undefined,
      sampleDepth: Number(track?.sampleDepth ?? track?.sample_depth) || undefined,
      trackNumber: Number(track?.trackNumber ?? track?.track_number) || undefined,
      discNumber: Number(track?.discNumber ?? track?.disc_number) || undefined,
      year: Number(track?.year) || undefined,
      analyzePath: String(track?.analyzePath ?? track?.analyze_path ?? '').trim() || undefined,
      comment: String(track?.comment || '').trim() || undefined,
      dateAdded: String(track?.dateAdded ?? track?.date_added ?? '').trim() || undefined,
      artworkId: Number(track?.artworkId ?? track?.artwork_id) || undefined,
      artworkPath: artworkPath || undefined,
      coverPath: coverPath || undefined
    }
  })

  return {
    drivePath: rootPath,
    exportPdbPath: String(result?.exportPdbPath ?? result?.export_pdb_path ?? probe.exportPdbPath),
    playlistId: Number(result?.playlistId ?? result?.playlist_id) || safePlaylistId,
    playlistName,
    trackTotal: Number(result?.trackTotal ?? result?.track_total) || tracks.length,
    tracks
  }
}
