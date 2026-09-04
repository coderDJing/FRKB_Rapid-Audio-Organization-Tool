import fs from 'fs-extra'
import { loadLibraryNodes, removeLibraryNode } from '../libraryTreeDb'
import {
  readCuratedLibrarySyncPendingDeletedNodeIds,
  writeCuratedLibrarySyncPendingDeletedNodeIds
} from '../librarySettingsDb'
import { getCuratedLibraryAbsRoot, getNodeAbsPath, isPathInside } from './paths'

const collectDescendantUuids = (rootUuid: string): string[] => {
  if (!rootUuid) return []
  const nodes = loadLibraryNodes() || []
  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.parentUuid) continue
    const list = childrenByParent.get(node.parentUuid) || []
    list.push(node.uuid)
    childrenByParent.set(node.parentUuid, list)
  }
  const result: string[] = []
  const queue = [...(childrenByParent.get(rootUuid) || [])]
  for (let i = 0; i < queue.length; i += 1) {
    const uuid = queue[i]
    if (!uuid) continue
    result.push(uuid)
    queue.push(...(childrenByParent.get(uuid) || []))
  }
  return result
}

export const listPendingDeletedCuratedNodeIds = (): Set<string> =>
  new Set(readCuratedLibrarySyncPendingDeletedNodeIds())

/** 用户在精选库删了歌单/文件夹：记下 UUID，避免对账或落地又把空壳建回来。 */
export const rememberCuratedLibraryNodeDeletion = (uuid: string, absPath: string): void => {
  const root = getCuratedLibraryAbsRoot()
  const id = String(uuid || '').trim()
  const abs = String(absPath || '').trim()
  if (!root || !id || !abs) return
  if (!isPathInside(abs, root)) return
  const next = listPendingDeletedCuratedNodeIds()
  next.add(id)
  for (const child of collectDescendantUuids(id)) next.add(child)
  writeCuratedLibrarySyncPendingDeletedNodeIds([...next])
}

export const prunePendingDeletedCuratedNodes = (cloudNodeIds: Set<string>): void => {
  const pending = readCuratedLibrarySyncPendingDeletedNodeIds()
  writeCuratedLibrarySyncPendingDeletedNodeIds(pending.filter((id) => cloudNodeIds.has(id)))
}

export const removeLocalPendingCuratedNodeShell = async (
  uuid: string,
  curatedRoot: string
): Promise<void> => {
  const abs = getNodeAbsPath(uuid)
  if (abs && isPathInside(abs, curatedRoot) && (await fs.pathExists(abs))) {
    const leftover = await fs.readdir(abs).catch(() => [])
    const meaningful = leftover.filter((name) => name !== '.frkb.uuid')
    if (meaningful.length === 0) await fs.remove(abs)
  }
  removeLibraryNode(uuid)
}
