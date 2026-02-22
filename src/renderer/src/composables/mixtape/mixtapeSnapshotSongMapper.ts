import type { ISongInfo } from '../../../../types/globals'

type MixtapeSnapshotSongRaw = {
  id?: string | number | null
  filePath?: string | null
  mixOrder?: number | string | null
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  infoJson?: string | null
}

type SnapshotInfo = Partial<ISongInfo> & {
  filePath?: string
}

type SnapshotMapperOptions = {
  buildDisplayPathByUuid?: (uuid: string) => string
}

const resolveFileNameAndFormat = (filePath: string) => {
  const baseName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  const fileFormat = ext ? ext.toUpperCase() : ''
  return { fileName: baseName, fileFormat }
}

const parseSnapshotInfo = (raw: MixtapeSnapshotSongRaw): SnapshotInfo | null => {
  if (!raw?.infoJson) return null
  try {
    return JSON.parse(String(raw.infoJson)) as SnapshotInfo
  } catch {
    return null
  }
}

export const mapMixtapeSnapshotToSongInfo = (
  raw: MixtapeSnapshotSongRaw,
  fallbackIndex: number,
  options: SnapshotMapperOptions = {}
): ISongInfo => {
  const info = parseSnapshotInfo(raw)
  const filePath = String(raw?.filePath || info?.filePath || '')
  const meta = resolveFileNameAndFormat(filePath)
  const originUuid = String(raw?.originPlaylistUuid || '')
  const originByUuid = options.buildDisplayPathByUuid?.(originUuid) || ''
  const originPathSnapshot = String(raw?.originPathSnapshot || '')

  return {
    filePath,
    fileName: info?.fileName || meta.fileName,
    fileFormat: info?.fileFormat || meta.fileFormat,
    cover: info?.cover ?? null,
    title: info?.title ?? meta.fileName,
    artist: info?.artist,
    album: info?.album,
    duration: info?.duration ?? '',
    genre: info?.genre,
    label: info?.label,
    bitrate: info?.bitrate,
    container: info?.container,
    key: info?.key,
    bpm: info?.bpm,
    mixOrder: Number(raw?.mixOrder) || fallbackIndex + 1,
    mixtapeItemId: raw?.id ? String(raw.id) : undefined,
    originalPlaylistPath: originByUuid || originPathSnapshot
  }
}
