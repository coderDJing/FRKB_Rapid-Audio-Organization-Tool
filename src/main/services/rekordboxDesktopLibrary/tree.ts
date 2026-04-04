import type { IPioneerPlaylistTreeNode } from '../../../types/globals'
import { requireRekordboxDesktopLibraryProbe } from './detect'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperTreeNode,
  RekordboxDesktopHelperTreePayload,
  RekordboxDesktopLibraryTreeLoadResult
} from './types'

const normalizeTreeNode = (
  node: RekordboxDesktopHelperTreeNode | null | undefined
): IPioneerPlaylistTreeNode | null => {
  const id = Number(node?.id) || 0
  const name = String(node?.name || '').trim()
  if (!id || !name) return null
  return {
    id,
    parentId: Number(node?.parentId) || 0,
    name,
    isFolder: Boolean(node?.isFolder),
    order: Number(node?.order) || 0
  }
}

export async function loadRekordboxDesktopPlaylistTree(): Promise<RekordboxDesktopLibraryTreeLoadResult> {
  const probe = await requireRekordboxDesktopLibraryProbe()
  const payload = await runRekordboxDesktopHelper<
    RekordboxDesktopHelperTreePayload,
    {
      dbPath: string
      dbDir: string
    }
  >('load-tree', {
    dbPath: probe.dbPath,
    dbDir: probe.dbDir
  })

  const nodes = Array.isArray(payload?.nodes)
    ? payload.nodes
        .map((node) => normalizeTreeNode(node))
        .filter((node): node is IPioneerPlaylistTreeNode => Boolean(node))
    : []

  return {
    probe,
    nodes
  }
}
