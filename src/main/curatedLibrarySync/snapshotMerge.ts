import { CURATED_LIBRARY_SYNC_PROTOCOL_VERSION } from '../../shared/curatedLibrarySync'
import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode,
  CuratedLibrarySyncSnapshot,
  CuratedLibrarySyncTombstone
} from '../../shared/curatedLibrarySync'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const asNodes = (value: unknown): CuratedLibrarySyncCloudNode[] =>
  Array.isArray(value) ? (value as CuratedLibrarySyncCloudNode[]) : []

const asFiles = (value: unknown): CuratedLibrarySyncCloudFile[] =>
  Array.isArray(value) ? (value as CuratedLibrarySyncCloudFile[]) : []

const asTombstones = (value: unknown): CuratedLibrarySyncTombstone[] =>
  Array.isArray(value) ? (value as CuratedLibrarySyncTombstone[]) : []

export const parseCuratedLibrarySnapshot = (raw: unknown): CuratedLibrarySyncSnapshot | null => {
  if (!isRecord(raw)) return null
  return {
    protocolVersion: Number(raw.protocolVersion) || CURATED_LIBRARY_SYNC_PROTOCOL_VERSION,
    revision: Number(raw.revision) || 0,
    snapshotReady: raw.snapshotReady === true,
    full: raw.full !== false,
    nodes: asNodes(raw.nodes),
    files: asFiles(raw.files),
    tombstones: asTombstones(raw.tombstones)
  }
}

export const mergeCuratedLibrarySnapshot = (
  cached: CuratedLibrarySyncSnapshot | null,
  pulled: CuratedLibrarySyncSnapshot
): CuratedLibrarySyncSnapshot => {
  if (pulled.full !== false || !cached) {
    return {
      protocolVersion: pulled.protocolVersion,
      revision: pulled.revision,
      snapshotReady: pulled.snapshotReady,
      full: true,
      nodes: pulled.nodes,
      files: pulled.files,
      tombstones: pulled.tombstones
    }
  }
  const nodes = new Map(cached.nodes.map((node) => [node.uuid, node]))
  const files = new Map(cached.files.map((file) => [file.fileId, file]))
  let tombstones = [...cached.tombstones]
  for (const node of pulled.nodes) {
    nodes.set(node.uuid, node)
    tombstones = tombstones.filter((item) => !(item.kind === 'node' && item.id === node.uuid))
  }
  for (const file of pulled.files) {
    files.set(file.fileId, file)
    tombstones = tombstones.filter((item) => !(item.kind === 'file' && item.id === file.fileId))
  }
  for (const tombstone of pulled.tombstones) {
    if (tombstone.kind === 'file') files.delete(tombstone.id)
    else nodes.delete(tombstone.id)
    const index = tombstones.findIndex(
      (item) => item.kind === tombstone.kind && item.id === tombstone.id
    )
    if (index >= 0) tombstones[index] = tombstone
    else tombstones.push(tombstone)
  }
  return {
    protocolVersion: pulled.protocolVersion,
    revision: pulled.revision,
    snapshotReady: pulled.snapshotReady,
    full: true,
    nodes: [...nodes.values()],
    files: [...files.values()],
    tombstones
  }
}
