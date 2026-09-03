import path from 'node:path'
import fs from 'fs-extra'
import os from 'node:os'
import store from '../store'
import {
  findLibraryNodeByPath,
  insertLibraryNode,
  loadLibraryNodes,
  moveLibraryNode,
  removeLibraryNode,
  updateLibraryNodeName,
  updateLibraryNodeOrder
} from '../libraryTreeDb'
import { writeUuidMarker } from '../libraryTreeDbHelpers'
import { protectSetReferencedFilesForDeletion } from '../ipc/setListHandlers'
import { getRecycleBinRecordByFileId, type RecycleBinRecord } from '../recycleBinDb'
import { moveFileToRecycleBin, restoreRecycleBinFile } from '../recycleBinService'
import { stampPlaylistSongsAddedAt } from '../services/playlistAddedAt'
import { setSongListTrackNumbersByOrder } from '../services/playlistTrackNumbers'
import { runPlaybackAwareBackgroundFileIo } from '../services/playbackForegroundActivity'
import { downloadBlobFile } from './apiClient'
import { isPathBusyForRemoteMutation } from './busyPaths'
import {
  relocateLibraryAudioFile,
  relocateLibraryDirectoryFiles,
  rememberImportedCuratedTracks
} from './localMutations'
import {
  getCuratedSyncFileById,
  upsertCuratedSyncFile,
  replaceCuratedSyncFileId,
  type CuratedSyncFileRow
} from './identityDb'
import {
  curatedRelativeToAbs,
  findCuratedLibraryNode,
  getCuratedLibraryAbsRoot,
  getLibraryAbsRoot,
  getNodeAbsPath,
  libraryRelativeToAbs
} from './paths'
import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode,
  CuratedLibrarySyncSnapshot
} from '../../shared/curatedLibrarySync'
import type { CuratedLocalFile, CuratedLocalNode } from './scan'

export type DeferredRemoteOp = {
  type: 'deleteFile' | 'moveFile' | 'deleteNode'
  fileId?: string
  nodeUuid?: string
  parentUuid?: string
  fileName?: string
  sha256?: string
}

export type ApplyRemoteContext = {
  signal: AbortSignal
  onProgress?: (labelKey: string, now: number, total: number) => void
  isBusy?: (absPath: string) => boolean
  onTransferFailure?: (payload: {
    direction: 'download'
    name: string
    sha256: string
    fileId: string
    error: unknown
  }) => void
}

export type ApplyRemoteOptions = {
  extras: 'keep' | 'delete'
  adoptIds: boolean
  applyTombstones?: boolean
  knownFileIds?: Set<string> | null
  knownNodeIds?: Set<string> | null
}

const isEnospc = (error: unknown): boolean => {
  const code = String((error as { code?: unknown } | null)?.code || '').toUpperCase()
  return code === 'ENOSPC' || /no space/i.test(String((error as Error)?.message || ''))
}

const assertNotCancelled = (signal: AbortSignal) => {
  if (signal.aborted) {
    const error = new Error('CURATED_SYNC_CANCELLED')
    error.name = 'AbortError'
    throw error
  }
}

const mappedLibraryPath = (absPath: string): string => {
  const dbRoot = String(store.databaseDir || '').trim()
  return path.relative(dbRoot, absPath).replace(/\\/g, '/')
}

const absToRel = (root: string, absPath: string): string =>
  path.relative(root, absPath).replace(/\\/g, '/')

const isBusyPath = (absPath: string, ctx: ApplyRemoteContext): boolean =>
  isPathBusyForRemoteMutation(absPath) || !!ctx.isBusy?.(absPath)

const adoptNodeUuid = (localUuid: string, cloudUuid: string): void => {
  if (!localUuid || !cloudUuid || localUuid === cloudUuid) return
  const nodes = loadLibraryNodes() || []
  if (nodes.some((node) => node.uuid === cloudUuid)) return
  const local = nodes.find((node) => node.uuid === localUuid)
  if (!local) return
  removeLibraryNode(localUuid)
  insertLibraryNode({
    uuid: cloudUuid,
    parentUuid: local.parentUuid,
    dirName: local.dirName,
    nodeType: local.nodeType,
    order: local.order
  })
  for (const child of nodes) {
    if (child.parentUuid !== localUuid) continue
    moveLibraryNode(child.uuid, cloudUuid, child.dirName)
  }
  const abs = getNodeAbsPath(cloudUuid)
  if (abs) void writeUuidMarker(abs, cloudUuid)
}

const ensureCloudNodeLocal = async (
  node: CuratedLibrarySyncCloudNode,
  curatedUuid: string
): Promise<string | null> => {
  const existing = (loadLibraryNodes() || []).find((item) => item.uuid === node.uuid)
  const parentAbs =
    node.parentUuid === curatedUuid ? getCuratedLibraryAbsRoot() : getNodeAbsPath(node.parentUuid)
  if (!parentAbs) return null
  const destAbs = path.join(parentAbs, node.name)
  if (existing) {
    const currentAbs = getNodeAbsPath(node.uuid)
    if (currentAbs && path.normalize(currentAbs) !== path.normalize(destAbs)) {
      await fs.ensureDir(path.dirname(destAbs))
      if (await fs.pathExists(currentAbs)) {
        await relocateLibraryDirectoryFiles(currentAbs, destAbs)
      }
      moveLibraryNode(node.uuid, node.parentUuid, node.name)
    } else if (existing.dirName !== node.name) {
      updateLibraryNodeName(node.uuid, node.name)
    }
    updateLibraryNodeOrder(node.uuid, node.sortOrder)
    await writeUuidMarker(destAbs, node.uuid)
    return destAbs
  }
  const mapped = mappedLibraryPath(destAbs)
  const collision = findLibraryNodeByPath(mapped)
  if (collision && collision.uuid !== node.uuid) {
    adoptNodeUuid(collision.uuid, node.uuid)
    updateLibraryNodeOrder(node.uuid, node.sortOrder)
    await writeUuidMarker(destAbs, node.uuid)
    return destAbs
  }
  await fs.ensureDir(destAbs)
  insertLibraryNode({
    uuid: node.uuid,
    parentUuid: node.parentUuid,
    dirName: node.name,
    nodeType: node.nodeType,
    order: node.sortOrder
  })
  await writeUuidMarker(destAbs, node.uuid)
  return destAbs
}

const restoreFromRecycle = async (
  record: RecycleBinRecord,
  destDir: string,
  fileName: string
): Promise<string | null> => {
  const restored = await restoreRecycleBinFile(record.filePath)
  if (restored.status !== 'restored' || !restored.destPath) return null
  if (
    path.dirname(restored.destPath) === destDir &&
    path.basename(restored.destPath) === fileName
  ) {
    return restored.destPath
  }
  const dest = path.join(destDir, fileName)
  return await relocateLibraryAudioFile({
    sourceAbs: restored.destPath,
    destAbs: dest,
    mode: 'move'
  })
}

const findCustodyFile = async (file: CuratedLibrarySyncCloudFile): Promise<string | null> => {
  const identity = getCuratedSyncFileById(file.fileId)
  if (identity?.location === 'custody' && identity.locationPath) {
    const abs = libraryRelativeToAbs(identity.locationPath)
    if (abs && (await fs.pathExists(abs))) return abs
  }
  return null
}

const importCloudFile = async (
  file: CuratedLibrarySyncCloudFile,
  ctx: ApplyRemoteContext
): Promise<string | null> => {
  assertNotCancelled(ctx.signal)
  const destDir = getNodeAbsPath(file.parentUuid)
  if (!destDir) return null
  await fs.ensureDir(destDir)
  const destPath = path.join(destDir, file.fileName)
  const recycle = getRecycleBinRecordByFileId(file.fileId)
  if (recycle) {
    const restored = await restoreFromRecycle(recycle, destDir, file.fileName)
    if (restored) return restored
  }
  const custody = await findCustodyFile(file)
  if (custody) {
    return await relocateLibraryAudioFile({
      sourceAbs: custody,
      destAbs: destPath,
      mode: 'move'
    })
  }
  const tempPath = path.join(
    os.tmpdir(),
    'frkb-curated-sync',
    `${file.fileId}-${file.sha256.slice(0, 8)}`
  )
  await fs.ensureDir(path.dirname(tempPath))
  await runPlaybackAwareBackgroundFileIo(
    'curated-library-sync:download-blob',
    { filePath: destPath },
    () =>
      downloadBlobFile({
        sha256: file.sha256,
        destPath: tempPath,
        expectedSize: file.size,
        signal: ctx.signal
      })
  )
  const finalPath = await relocateLibraryAudioFile({
    sourceAbs: tempPath,
    destAbs: destPath,
    mode: 'move'
  })
  await stampPlaylistSongsAddedAt({
    listRoot: destDir,
    filePaths: [finalPath],
    addedAtMs: file.addedAtMs ?? undefined
  })
  rememberImportedCuratedTracks([finalPath])
  return finalPath
}

const tryImportCloudFile = async (
  file: CuratedLibrarySyncCloudFile,
  ctx: ApplyRemoteContext
): Promise<string | null> => {
  try {
    return await importCloudFile(file, ctx)
  } catch (error) {
    if (isEnospc(error)) throw error
    if ((error as { name?: string })?.name === 'AbortError') throw error
    ctx.onTransferFailure?.({
      direction: 'download',
      name: file.fileName,
      sha256: file.sha256,
      fileId: file.fileId,
      error
    })
    return null
  }
}

const persistImportedIdentity = (
  file: CuratedLibrarySyncCloudFile,
  absPath: string,
  relativePath: string
) => {
  const existing = getCuratedSyncFileById(file.fileId)
  const row: CuratedSyncFileRow = {
    fileId: file.fileId,
    relativePath,
    parentUuid: file.parentUuid,
    fileName: path.basename(absPath),
    contentSha256: file.sha256,
    contentSize: file.size,
    mtimeMs: Date.now(),
    trackNumber: file.trackNumber,
    addedAtMs: file.addedAtMs,
    updatedAtMs: file.updatedAtMs,
    location: 'curated',
    locationPath: relativePath
  }
  if (existing && existing.fileId !== file.fileId) {
    replaceCuratedSyncFileId(existing.fileId, file.fileId)
  }
  upsertCuratedSyncFile(row)
}

const deleteLocalFile = async (absPath: string, ctx: ApplyRemoteContext): Promise<boolean> => {
  if (isBusyPath(absPath, ctx)) return false
  const setProtection = await protectSetReferencedFilesForDeletion([absPath])
  if (setProtection.protectedFiles.some((item) => item.filePath === absPath && item.success)) {
    return true
  }
  const result = await moveFileToRecycleBin(absPath)
  return result.status === 'moved' || result.status === 'skipped'
}

const resolveLocalAbsForFileId = (
  fileId: string,
  localById: Map<string, CuratedLocalFile>
): string | null => {
  const localFile = localById.get(fileId)
  if (localFile?.absPath) return localFile.absPath
  const identity = getCuratedSyncFileById(fileId)
  if (identity?.location === 'curated' && identity.relativePath) {
    return curatedRelativeToAbs(identity.relativePath)
  }
  return null
}

const shouldSkipRestoringCloudFile = (
  file: CuratedLibrarySyncCloudFile,
  options: ApplyRemoteOptions
): boolean => {
  if (options.extras === 'delete' || options.adoptIds) return false
  const identity = getCuratedSyncFileById(file.fileId)
  const locallyRemoved = !!identity && identity.location !== 'curated'
  if (locallyRemoved) {
    return options.knownFileIds == null || options.knownFileIds.has(file.fileId)
  }
  return !identity && !!options.knownFileIds?.has(file.fileId)
}

const shouldSkipRecreatingCloudNode = (nodeUuid: string, options: ApplyRemoteOptions): boolean => {
  if (options.extras === 'delete' || options.adoptIds) return false
  if (options.knownNodeIds == null) return false
  return options.knownNodeIds.has(nodeUuid)
}

const sortNodesParentsFirst = (nodes: CuratedLibrarySyncCloudNode[]) => {
  const remaining = [...nodes]
  const ordered: CuratedLibrarySyncCloudNode[] = []
  const seen = new Set<string>()
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex(
      (node) =>
        seen.has(node.parentUuid) || !remaining.some((item) => item.uuid === node.parentUuid)
    )
    const index = nextIndex >= 0 ? nextIndex : 0
    const [node] = remaining.splice(index, 1)
    if (!node) break
    ordered.push(node)
    seen.add(node.uuid)
  }
  return ordered
}

const applyTrackNumbers = async (files: CuratedLibrarySyncCloudFile[]) => {
  const grouped = new Map<string, CuratedLibrarySyncCloudFile[]>()
  for (const file of files) {
    const list = grouped.get(file.parentUuid) || []
    list.push(file)
    grouped.set(file.parentUuid, list)
  }
  for (const [parentUuid, group] of grouped) {
    const listRoot = getNodeAbsPath(parentUuid)
    if (!listRoot) continue
    const ordered = [...group].sort((left, right) => {
      const leftNum = Number(left.trackNumber) || Number.MAX_SAFE_INTEGER
      const rightNum = Number(right.trackNumber) || Number.MAX_SAFE_INTEGER
      if (leftNum !== rightNum) return leftNum - rightNum
      return left.fileName.localeCompare(right.fileName)
    })
    const absPaths: string[] = []
    for (const file of ordered) {
      const identity = getCuratedSyncFileById(file.fileId)
      const abs =
        (identity?.relativePath && curatedRelativeToAbs(identity.relativePath)) ||
        path.join(listRoot, file.fileName)
      if (await fs.pathExists(abs)) absPaths.push(abs)
    }
    if (absPaths.length > 0) {
      await setSongListTrackNumbersByOrder({ listRoot, orderedFilePaths: absPaths })
    }
  }
}

const applyFileTombstones = async (
  snapshot: CuratedLibrarySyncSnapshot,
  localById: Map<string, CuratedLocalFile>,
  curatedRoot: string,
  ctx: ApplyRemoteContext
): Promise<DeferredRemoteOp[]> => {
  const deferred: DeferredRemoteOp[] = []
  const cloudFileIds = new Set(snapshot.files.map((file) => file.fileId))
  for (const tombstone of snapshot.tombstones) {
    if (tombstone.kind !== 'file' || cloudFileIds.has(tombstone.id)) continue
    assertNotCancelled(ctx.signal)
    const abs = resolveLocalAbsForFileId(tombstone.id, localById)
    if (!abs || !abs.startsWith(curatedRoot) || !(await fs.pathExists(abs))) continue
    const identity = getCuratedSyncFileById(tombstone.id)
    if (
      identity &&
      identity.updatedAtMs > tombstone.deletedAtMs &&
      identity.location === 'curated'
    ) {
      continue
    }
    if (isBusyPath(abs, ctx)) {
      deferred.push({ type: 'deleteFile', fileId: tombstone.id })
      continue
    }
    await deleteLocalFile(abs, ctx)
  }
  return deferred
}

const applyNodeTombstones = async (
  snapshot: CuratedLibrarySyncSnapshot,
  curatedRoot: string,
  ctx: ApplyRemoteContext
): Promise<DeferredRemoteOp[]> => {
  const deferred: DeferredRemoteOp[] = []
  const cloudNodeIds = new Set(snapshot.nodes.map((node) => node.uuid))
  const tombstoned = snapshot.tombstones
    .filter((item) => item.kind === 'node' && !cloudNodeIds.has(item.id))
    .map((item) => item.id)
  const withDepth = tombstoned
    .map((uuid) => {
      const abs = getNodeAbsPath(uuid)
      return { uuid, abs, depth: abs ? abs.split(/[/\\]/).length : 0 }
    })
    .sort((left, right) => right.depth - left.depth)
  for (const item of withDepth) {
    assertNotCancelled(ctx.signal)
    if (!item.abs || !item.abs.startsWith(curatedRoot) || !(await fs.pathExists(item.abs))) {
      const nodes = loadLibraryNodes() || []
      if (nodes.some((node) => node.uuid === item.uuid)) removeLibraryNode(item.uuid)
      continue
    }
    const leftover = await fs.readdir(item.abs).catch(() => [])
    const meaningful = leftover.filter((name) => name !== '.frkb.uuid')
    if (meaningful.length > 0) {
      deferred.push({ type: 'deleteNode', nodeUuid: item.uuid })
      continue
    }
    await fs.remove(item.abs)
    removeLibraryNode(item.uuid)
  }
  return deferred
}

export const applyRemoteSnapshot = async (
  snapshot: CuratedLibrarySyncSnapshot,
  local: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  options: ApplyRemoteOptions,
  ctx: ApplyRemoteContext
): Promise<{ deferred: DeferredRemoteOp[]; diskFull: boolean }> => {
  const deferred: DeferredRemoteOp[] = []
  const curated = findCuratedLibraryNode()
  const curatedRoot = getCuratedLibraryAbsRoot()
  const libraryRoot = getLibraryAbsRoot()
  if (!curated || !curatedRoot || !libraryRoot) return { deferred, diskFull: false }

  try {
    const orderedNodes = sortNodesParentsFirst(
      snapshot.nodes.filter((node) => node.parentUuid && node.uuid)
    )
    for (const node of orderedNodes) {
      assertNotCancelled(ctx.signal)
      const existing = (loadLibraryNodes() || []).find((item) => item.uuid === node.uuid)
      if (!existing && shouldSkipRecreatingCloudNode(node.uuid, options)) continue
      await ensureCloudNodeLocal(node, curated.uuid)
    }

    const cloudFileIds = new Set(snapshot.files.map((file) => file.fileId))
    const localById = new Map(local.files.map((file) => [file.fileId, file]))
    const localByHash = new Map<string, CuratedLocalFile[]>()
    for (const file of local.files) {
      const list = localByHash.get(file.contentSha256) || []
      list.push(file)
      localByHash.set(file.contentSha256, list)
    }

    let index = 0
    const reportApplyProgress = (downloading: boolean) => {
      ctx.onProgress?.(
        downloading
          ? 'cloudSync.curatedLibrary.progressDownloading'
          : 'cloudSync.curatedLibrary.progressApplying',
        index,
        snapshot.files.length
      )
    }
    for (const file of snapshot.files) {
      assertNotCancelled(ctx.signal)
      index += 1
      const localFile = localById.get(file.fileId)
      let matched = localFile
      if (!matched && options.adoptIds) {
        const hashMatches = localByHash.get(file.sha256) || []
        matched = hashMatches.find((item) => item.fileName === file.fileName) || hashMatches[0]
        if (matched && matched.fileId !== file.fileId) {
          replaceCuratedSyncFileId(matched.fileId, file.fileId)
          matched = { ...matched, fileId: file.fileId }
        }
      }
      const destDir = getNodeAbsPath(file.parentUuid)
      if (!destDir) continue
      if (matched) {
        const destPath = path.join(destDir, file.fileName)
        if (isBusyPath(matched.absPath, ctx)) {
          deferred.push({
            type: 'moveFile',
            fileId: file.fileId,
            parentUuid: file.parentUuid,
            fileName: file.fileName,
            sha256: file.sha256
          })
          continue
        }
        if (matched.contentSha256 !== file.sha256) {
          reportApplyProgress(true)
          const imported = await tryImportCloudFile(file, ctx)
          if (imported) {
            await moveFileToRecycleBin(matched.absPath)
            persistImportedIdentity(
              file,
              imported,
              path.posix.join(
                path.relative(curatedRoot, destDir).replace(/\\/g, '/'),
                path.basename(imported)
              )
            )
          }
          continue
        }
        if (path.normalize(matched.absPath) !== path.normalize(destPath)) {
          reportApplyProgress(false)
          const moved = await relocateLibraryAudioFile({
            sourceAbs: matched.absPath,
            destAbs: destPath,
            mode: 'move'
          })
          persistImportedIdentity(file, moved, absToRel(curatedRoot, moved))
        } else {
          persistImportedIdentity(file, matched.absPath, absToRel(curatedRoot, matched.absPath))
        }
        continue
      }
      if (shouldSkipRestoringCloudFile(file, options)) continue
      reportApplyProgress(true)
      const imported = await tryImportCloudFile(file, ctx)
      if (imported) persistImportedIdentity(file, imported, absToRel(curatedRoot, imported))
    }

    if (options.applyTombstones !== false) {
      deferred.push(...(await applyFileTombstones(snapshot, localById, curatedRoot, ctx)))
      deferred.push(...(await applyNodeTombstones(snapshot, curatedRoot, ctx)))
    }

    if (options.extras === 'delete') {
      const extraFiles = local.files.filter((localFile) => !cloudFileIds.has(localFile.fileId))
      let extraIndex = 0
      for (const localFile of extraFiles) {
        extraIndex += 1
        ctx.onProgress?.(
          'cloudSync.curatedLibrary.progressApplying',
          extraIndex,
          Math.max(extraFiles.length, 1)
        )
        assertNotCancelled(ctx.signal)
        if (isBusyPath(localFile.absPath, ctx)) {
          deferred.push({ type: 'deleteFile', fileId: localFile.fileId })
          continue
        }
        await deleteLocalFile(localFile.absPath, ctx)
      }
      const cloudNodeIds = new Set(snapshot.nodes.map((node) => node.uuid))
      const localNodes = [...local.nodes].reverse()
      for (const node of localNodes) {
        if (cloudNodeIds.has(node.uuid)) continue
        const abs = getNodeAbsPath(node.uuid)
        if (!abs || !abs.startsWith(curatedRoot)) continue
        const leftover = await fs.readdir(abs).catch(() => [])
        const meaningful = leftover.filter((name) => name !== '.frkb.uuid')
        if (meaningful.length === 0) {
          await fs.remove(abs)
          removeLibraryNode(node.uuid)
        }
      }
    }

    await applyTrackNumbers(snapshot.files)
    return { deferred, diskFull: false }
  } catch (error) {
    if (isEnospc(error)) return { deferred, diskFull: true }
    throw error
  }
}

export const retryDeferredRemoteOps = async (
  ops: DeferredRemoteOp[],
  snapshot: CuratedLibrarySyncSnapshot,
  ctx: ApplyRemoteContext
): Promise<DeferredRemoteOp[]> => {
  const remaining: DeferredRemoteOp[] = []
  const cloudFiles = new Map(snapshot.files.map((file) => [file.fileId, file]))
  const cloudNodes = new Set(snapshot.nodes.map((node) => node.uuid))
  const tombstonedFiles = new Set(
    snapshot.tombstones.filter((item) => item.kind === 'file').map((item) => item.id)
  )
  const tombstonedNodes = new Set(
    snapshot.tombstones.filter((item) => item.kind === 'node').map((item) => item.id)
  )
  const localById = new Map<string, CuratedLocalFile>()
  const curatedRoot = getCuratedLibraryAbsRoot()
  for (const op of ops) {
    assertNotCancelled(ctx.signal)
    if (op.type === 'deleteFile') {
      const fileId = String(op.fileId || '').trim()
      if (!fileId) continue
      if (!tombstonedFiles.has(fileId) && cloudFiles.has(fileId)) continue
      const abs = resolveLocalAbsForFileId(fileId, localById)
      if (!abs || !(await fs.pathExists(abs))) continue
      if (isBusyPath(abs, ctx)) {
        remaining.push(op)
        continue
      }
      await deleteLocalFile(abs, ctx)
      continue
    }
    if (op.type === 'deleteNode') {
      const uuid = String(op.nodeUuid || '').trim()
      if (!uuid) continue
      if (!tombstonedNodes.has(uuid) && cloudNodes.has(uuid)) continue
      if (!curatedRoot) continue
      const extra = await applyNodeTombstones(
        {
          ...snapshot,
          tombstones: snapshot.tombstones.filter((item) => item.kind === 'node' && item.id === uuid)
        },
        curatedRoot,
        ctx
      )
      remaining.push(...extra)
      continue
    }
    const fileId = String(op.fileId || '').trim()
    const cloud = cloudFiles.get(fileId)
    if (!cloud) continue
    const identity = getCuratedSyncFileById(fileId)
    const abs = identity?.relativePath ? curatedRelativeToAbs(identity.relativePath) : null
    if (!abs || !(await fs.pathExists(abs))) continue
    if (isBusyPath(abs, ctx)) {
      remaining.push(op)
      continue
    }
    const destDir = getNodeAbsPath(cloud.parentUuid)
    if (!destDir) continue
    const destPath = path.join(destDir, cloud.fileName)
    await relocateLibraryAudioFile({
      sourceAbs: abs,
      destAbs: destPath,
      mode: 'move'
    })
  }
  return remaining
}

export const buildCloudEntitiesFromLocal = (local: {
  files: CuratedLocalFile[]
  nodes: CuratedLocalNode[]
}): { nodes: CuratedLibrarySyncCloudNode[]; files: CuratedLibrarySyncCloudFile[] } => {
  const now = Date.now()
  return {
    nodes: local.nodes.map((node) => ({
      uuid: node.uuid,
      parentUuid: node.parentUuid,
      name: node.name,
      nodeType: node.nodeType,
      sortOrder: node.sortOrder,
      updatedAtMs: node.updatedAtMs || now
    })),
    files: local.files.map((file) => ({
      fileId: file.fileId,
      parentUuid: file.parentUuid,
      fileName: file.fileName,
      sha256: file.contentSha256,
      size: file.contentSize,
      trackNumber: file.trackNumber,
      addedAtMs: file.addedAtMs,
      updatedAtMs: file.updatedAtMs || now
    }))
  }
}

export const diffLocalAgainstSnapshot = (
  local: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  snapshot: CuratedLibrarySyncSnapshot
) => {
  const cloudFiles = new Map(snapshot.files.map((file) => [file.fileId, file]))
  const cloudNodes = new Map(snapshot.nodes.map((node) => [node.uuid, node]))
  const tombstoneFiles = new Map(
    snapshot.tombstones
      .filter((item) => item.kind === 'file')
      .map((item) => [item.id, item] as const)
  )
  const tombstoneNodes = new Set(
    snapshot.tombstones.filter((item) => item.kind === 'node').map((item) => item.id)
  )
  const localFileIds = new Set(local.files.map((file) => file.fileId))
  const localNodeIds = new Set(local.nodes.map((node) => node.uuid))
  return {
    cloudFiles,
    cloudNodes,
    tombstoneFiles,
    tombstoneNodes,
    localFileIds,
    localNodeIds
  }
}
