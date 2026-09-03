import type {
  CuratedLibrarySyncConflictItem,
  CuratedLibrarySyncOp,
  CuratedLibrarySyncSnapshot
} from '../../shared/curatedLibrarySync'

const sameTrackNumber = (left: number | null | undefined, right: number | null | undefined) =>
  (Number(left) || 0) === (Number(right) || 0)

export const collectDroppedOps = (
  ops: CuratedLibrarySyncOp[],
  winning: CuratedLibrarySyncSnapshot
): CuratedLibrarySyncConflictItem[] => {
  const files = new Map(winning.files.map((file) => [file.fileId, file]))
  const nodes = new Map(winning.nodes.map((node) => [node.uuid, node]))
  const items: CuratedLibrarySyncConflictItem[] = []
  for (const op of ops) {
    if (op.type === 'upsertFile' || op.type === 'undeleteFile') {
      const cloud = files.get(op.file.fileId)
      if (!cloud) {
        items.push({
          kind: op.type === 'undeleteFile' ? 'file-undelete-lost' : 'file-content-lost',
          name: op.file.fileName
        })
        continue
      }
      if (cloud.parentUuid !== op.file.parentUuid) {
        items.push({ kind: 'file-move-lost', name: op.file.fileName })
      } else if (cloud.fileName !== op.file.fileName) {
        items.push({
          kind: 'file-rename-lost',
          name: op.file.fileName,
          otherName: cloud.fileName
        })
      } else if (cloud.sha256 !== op.file.sha256) {
        items.push({ kind: 'file-content-lost', name: op.file.fileName })
      } else if (!sameTrackNumber(cloud.trackNumber, op.file.trackNumber)) {
        items.push({ kind: 'file-order-lost', name: op.file.fileName })
      }
      continue
    }
    if (op.type === 'deleteFile') {
      const cloud = files.get(op.fileId)
      if (cloud) {
        items.push({ kind: 'file-delete-lost', name: cloud.fileName })
      }
      continue
    }
    if (op.type === 'upsertNode') {
      const cloud = nodes.get(op.node.uuid)
      if (!cloud) {
        items.push({ kind: 'node-delete-lost', name: op.node.name })
        continue
      }
      if (cloud.name !== op.node.name || cloud.parentUuid !== op.node.parentUuid) {
        items.push({
          kind: 'node-change-lost',
          name: op.node.name,
          otherName: cloud.name
        })
      }
      continue
    }
    const cloud = nodes.get(op.uuid)
    if (cloud) {
      items.push({ kind: 'node-delete-lost', name: cloud.name })
    }
  }
  return items
}
