import { IDir } from '../../../types/globals'
import { v4 as uuidV4 } from 'uuid'
import { getCurrentTimeDirName } from './utils'

export interface FileSystemOperation {
  type: 'create' | 'delete' | 'permanentlyDelete' | 'rename' | 'move' | 'reorder'
  path: string
  newPath?: string
  newName?: string
  order?: number
  oldOrder?: number
  uuid: string
  nodeType?: string
  recycleBinDir?: {
    uuid: string
    order: number
    type: 'songList'
    dirName: string
  }
}

export function calculateFileSystemOperations(oldTree: IDir, newTree: IDir): FileSystemOperation[] {
  const operations: FileSystemOperation[] = []
  const deletedPaths = new Set<string>() // 跟踪已删除的路径
  const movedNodes = new Map<string, { oldPath: string; newPath: string; node: IDir }>() // 跟踪移动的节点
  const processedForMove = new Set<string>() // 专门跟踪已处理的移动节点

  // 检查路径是否在回收站节点下
  function isInTrash(path: string): boolean {
    return path.startsWith('library/回收站')
  }

  // 预处理：构建UUID到路径的映射
  function buildUuidPathMap(
    node: IDir,
    parentPath: string = '',
    map = new Map<string, string>()
  ): Map<string, string> {
    const fullPath = parentPath ? `${parentPath}/${node.dirName}` : node.dirName
    map.set(node.uuid, fullPath)

    if (node.children && node.children.length > 0) {
      node.children.forEach((child) => buildUuidPathMap(child, fullPath, map))
    }

    return map
  }

  // 构建UUID到路径的映射
  const oldUuidPathMap = buildUuidPathMap(oldTree)
  const newUuidPathMap = buildUuidPathMap(newTree)

  // 首先检测移动的节点
  oldUuidPathMap.forEach((oldPath, uuid) => {
    const newPath = newUuidPathMap.get(uuid)
    if (newPath && oldPath !== newPath) {
      // 如果节点在新旧树中路径不同，可能是移动操作
      // 但需要排除仅由于父节点重命名导致的路径变化

      const oldParts = oldPath.split('/')
      const newParts = newPath.split('/')

      // 如果只是末尾节点名称变化，这是重命名而非移动
      if (
        oldParts.length === newParts.length &&
        oldParts.slice(0, -1).join('/') === newParts.slice(0, -1).join('/')
      ) {
        // 这是重命名操作，不记录为移动
        return
      }

      // 否则，这是一个移动操作
      const getNodeByUuid = (tree: IDir, targetUuid: string): IDir | null => {
        if (tree.uuid === targetUuid) return tree
        if (!tree.children) return null

        for (const child of tree.children) {
          const found = getNodeByUuid(child, targetUuid)
          if (found) return found
        }

        return null
      }

      const node = getNodeByUuid(newTree, uuid)
      if (node) {
        movedNodes.set(uuid, { oldPath, newPath, node })
      }
    }
  })

  // 递归处理目录树
  function processTree(
    oldNode: IDir | undefined,
    newNode: IDir | undefined,
    parentPath: string = ''
  ) {
    // 构建完整路径
    const getFullPath = (node: IDir) => {
      return parentPath ? `${parentPath}/${node.dirName}` : node.dirName
    }

    if (!oldNode && newNode) {
      // 新增节点 - 只需要创建文件夹，order会在.description.json中设置
      const newPath = getFullPath(newNode)

      // 检查是否是移动的节点
      if (movedNodes.has(newNode.uuid)) {
        // 这是一个移动操作，不要创建
        const moveInfo = movedNodes.get(newNode.uuid)!

        // 如果这个节点还没有被处理为移动操作
        if (!processedForMove.has(newNode.uuid)) {
          operations.push({
            type: 'move',
            path: moveInfo.oldPath,
            newPath: moveInfo.newPath,
            uuid: newNode.uuid,
            nodeType: newNode.type,
            order: newNode.order
          })
          processedForMove.add(newNode.uuid)
        }

        // 如果有子节点，仍然需要处理
        if (newNode.children && newNode.children.length > 0) {
          const nextParentPath = newPath
          newNode.children.forEach((child) => {
            processTree(undefined, child, nextParentPath)
          })
        }

        return
      }

      operations.push({
        type: 'create',
        path: newPath,
        order: newNode.order,
        uuid: newNode.uuid,
        nodeType: newNode.type
      })

      // 递归处理子节点
      if (newNode.children) {
        const nextParentPath = newPath
        newNode.children.forEach((child) => {
          processTree(undefined, child, nextParentPath)
        })
      }
    } else if (oldNode && !newNode) {
      // 删除节点 - 检查父路径是否已被删除
      const oldPath = getFullPath(oldNode)

      // 如果这个节点已经被处理为移动操作，跳过删除
      if (processedForMove.has(oldNode.uuid)) {
        return
      }

      // 检查是否有父路径已被标记为删除
      const isParentDeleted = Array.from(deletedPaths).some(
        (path) => oldPath.startsWith(path + '/') || oldPath === path
      )

      // 检查节点是否被移动而不是删除
      if (movedNodes.has(oldNode.uuid)) {
        const moveInfo = movedNodes.get(oldNode.uuid)!

        // 如果这个节点还没有被处理为移动操作
        if (!processedForMove.has(oldNode.uuid)) {
          operations.push({
            type: 'move',
            path: moveInfo.oldPath,
            newPath: moveInfo.newPath,
            uuid: oldNode.uuid,
            nodeType: oldNode.type,
            order: moveInfo.node.order
          })
          processedForMove.add(oldNode.uuid)
        }

        return
      }

      if (!isParentDeleted) {
        operations.push({
          type: isInTrash(oldPath) ? 'permanentlyDelete' : 'delete',
          path: oldPath,
          uuid: oldNode.uuid,
          nodeType: oldNode.type,
          ...(!isInTrash(oldPath) && {
            recycleBinDir: {
              uuid: uuidV4(),
              dirName: getCurrentTimeDirName(),
              type: 'songList',
              order: Date.now()
            }
          })
        })
        deletedPaths.add(oldPath) // 标记此路径已被删除
      }

      // 不再递归处理子节点，因为父节点删除会自动删除所有子节点
    } else if (oldNode && newNode) {
      // 节点存在，检查是否需要重命名或移动
      const oldPath = getFullPath(oldNode)
      const newPath = getFullPath(newNode)

      // 如果这个节点已经作为移动操作处理，则跳过重命名和重排序
      if (processedForMove.has(oldNode.uuid)) {
        // 但仍然需要处理子节点
        if (oldNode.children || newNode.children) {
          const oldChildren = oldNode.children || []
          const newChildren = newNode.children || []

          // 创建子节点映射
          const oldMap = new Map(oldChildren.map((child) => [child.uuid, child]))
          const newMap = new Map(newChildren.map((child) => [child.uuid, child]))

          // 处理新增的子节点
          newChildren.forEach((newChild) => {
            if (!oldMap.has(newChild.uuid)) {
              processTree(undefined, newChild, newPath)
            }
          })

          // 处理删除的子节点
          oldChildren.forEach((oldChild) => {
            if (!newMap.has(oldChild.uuid)) {
              processTree(oldChild, undefined, oldPath)
            }
          })

          // 处理保留的子节点
          oldChildren.forEach((oldChild) => {
            const newChild = newMap.get(oldChild.uuid)
            if (newChild) {
              processTree(oldChild, newChild, newPath)
            }
          })
        }
        return
      }

      if (oldNode.dirName !== newNode.dirName) {
        operations.push({
          type: 'rename',
          path: oldPath,
          newPath: newPath,
          newName: newNode.dirName,
          uuid: newNode.uuid,
          nodeType: newNode.type
        })
      }

      // 检查order是否发生变化 - 这是唯一需要修改.description.json的情况
      if (oldNode.order !== newNode.order) {
        operations.push({
          type: 'reorder',
          path: newPath,
          order: newNode.order,
          oldOrder: oldNode.order,
          uuid: newNode.uuid,
          nodeType: newNode.type
        })
      }

      // 处理子节点
      if (oldNode.children || newNode.children) {
        const oldChildren = oldNode.children || []
        const newChildren = newNode.children || []

        // 创建子节点映射
        const oldMap = new Map(oldChildren.map((child) => [child.uuid, child]))
        const newMap = new Map(newChildren.map((child) => [child.uuid, child]))

        // 创建名称到节点的映射，用于检测同名冲突
        const oldNameMap = new Map(oldChildren.map((child) => [child.dirName, child]))

        // 处理新增的子节点
        newChildren.forEach((newChild) => {
          if (!oldMap.has(newChild.uuid)) {
            // 检查是否存在同名节点
            const existingNode = oldNameMap.get(newChild.dirName)
            if (existingNode) {
              // 如果存在同名节点，先删除它
              const childOldPath = `${newPath}/${existingNode.dirName}`

              // 如果这个节点已经作为移动操作处理，则跳过删除
              if (processedForMove.has(existingNode.uuid)) {
                return
              }

              operations.push({
                type: isInTrash(childOldPath) ? 'permanentlyDelete' : 'delete',
                path: childOldPath,
                uuid: existingNode.uuid,
                nodeType: existingNode.type,
                ...(!isInTrash(childOldPath) && {
                  recycleBinDir: {
                    uuid: uuidV4(),
                    dirName: getCurrentTimeDirName(),
                    type: 'songList',
                    order: Date.now()
                  }
                })
              })
              deletedPaths.add(childOldPath) // 标记此路径已被删除
            }
            processTree(undefined, newChild, newPath)
          }
        })

        // 处理删除的子节点
        oldChildren.forEach((oldChild) => {
          if (!newMap.has(oldChild.uuid)) {
            processTree(oldChild, undefined, oldPath)
          }
        })

        // 处理保留的子节点
        oldChildren.forEach((oldChild) => {
          const newChild = newMap.get(oldChild.uuid)
          if (newChild) {
            processTree(oldChild, newChild, newPath)
          }
        })
      }
    }
  }

  processTree(oldTree, newTree)

  // 按照操作类型和路径深度排序
  return operations.sort((a, b) => {
    // 如果两个操作都是删除相关操作，按路径深度排序（更深的路径先删除）
    if (
      (a.type === 'delete' || a.type === 'permanentlyDelete') &&
      (b.type === 'delete' || b.type === 'permanentlyDelete')
    ) {
      const aDepth = a.path.split('/').length
      const bDepth = b.path.split('/').length
      return bDepth - aDepth // 深度大的排在前面
    }

    // 首先执行删除相关操作
    if (
      (a.type === 'delete' || a.type === 'permanentlyDelete') &&
      !(b.type === 'delete' || b.type === 'permanentlyDelete')
    )
      return -1
    if (
      !(a.type === 'delete' || a.type === 'permanentlyDelete') &&
      (b.type === 'delete' || b.type === 'permanentlyDelete')
    )
      return 1

    // 然后执行重命名操作
    if (a.type === 'rename' && b.type !== 'rename') return -1
    if (a.type !== 'rename' && b.type === 'rename') return 1

    // 再执行移动操作
    if (a.type === 'move' && b.type !== 'move') return -1
    if (a.type !== 'move' && b.type === 'move') return 1

    // 最后执行创建和重排序操作
    if (a.type === 'create' && b.type !== 'create') return -1
    if (a.type !== 'create' && b.type === 'create') return 1

    // 对于相同类型的操作，按照order排序
    if (a.order !== undefined && b.order !== undefined) {
      return a.order - b.order
    }

    return 0
  })
}
