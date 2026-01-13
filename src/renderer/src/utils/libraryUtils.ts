import { useRuntimeStore } from '@renderer/stores/runtime'
import { IDir } from 'src/types/globals'
import { calculateFileSystemOperations } from './diffLibraryTree'

export const diffLibraryTreeExecuteFileOperation = async () => {
  const runtime = useRuntimeStore()
  // 1. 计算操作
  const operations = calculateFileSystemOperations(runtime.oldLibraryTree, runtime.libraryTree)

  // 如果没有操作，直接返回
  if (operations.length === 0) {
    runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree)) // 仍然同步 oldTree
    return
  }

  // 2. 发送操作到主进程
  const result = await window.electron.ipcRenderer.invoke('operateFileSystemChange', operations)

  // 3. 处理返回结果并更新 UI
  if (result.success && result.details) {
    // 4. 同步 oldLibraryTree
    runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
  } else {
    // 处理主进程报告的失败
    console.error('File system operations failed:', result.error)
    // 这里可能需要通知用户，或者尝试恢复/重新同步状态
    // 暂时不同步 oldLibraryTree，以便下次 diff 可以检测到差异
  }
}

//根据UUID寻找LibraryTree中对应的对象的父级对象
export const getFatherLibraryTreeByUUID = (targetUuid: string) => {
  const runtime = useRuntimeStore()
  let data = runtime.libraryTree
  // 定义一个辅助函数来递归搜索子对象

  function searchChildren(children: IDir[], targetUuid: string, parent: IDir): IDir | null {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]

      // 如果当前子对象就是要找的对象，返回其父级
      if (child.uuid === targetUuid) {
        return parent
      }

      // 如果当前子对象有子对象，则递归搜索
      if (child.children && child.children.length > 0) {
        const foundParent = searchChildren(child.children, targetUuid, child)
        if (foundParent) {
          return foundParent
        }
      }
    }
    return null // 没有找到
  }
  if (data.children) {
    // 调用辅助函数开始搜索
    return searchChildren(data.children, targetUuid, data) // 初始调用时，parent 为根对象本身
  } else {
    return null
  }
}

//根据UUID寻找LibraryTree中对应的对象
export const getLibraryTreeByUUID = (uuid: string, libraryTree?: IDir): IDir | null => {
  if (libraryTree === undefined) {
    const runtime = useRuntimeStore()
    libraryTree = runtime.libraryTree
  }
  // 如果当前对象就是要找的对象，直接返回
  if (libraryTree.uuid === uuid) {
    return libraryTree
  }

  // 遍历子对象
  if (libraryTree.children && libraryTree.children.length > 0) {
    for (let i = 0; i < libraryTree.children.length; i++) {
      // 递归调用函数
      const found = getLibraryTreeByUUID(uuid, libraryTree.children[i])
      if (found) {
        return found // 如果在子对象中找到了，就返回
      }
    }
  }
  // 如果没有找到，返回null
  return null
}

//根据UUID寻找LibraryTree中对应的对象的路径
export const findDirPathByUuid = (targetUuid: string, path: string = '', data?: IDir): string => {
  if (data === undefined) {
    const runtime = useRuntimeStore()
    data = runtime.libraryTree
  }
  // 如果当前对象的uuid就是要找的uuid，返回当前路径
  if (data.uuid === targetUuid) {
    return path + (path ? '/' : '') + data.dirName // 加上根目录的dirName（如果有的话）
  }

  // 遍历子对象
  if (data.children && data.children.length > 0) {
    for (let i = 0; i < data.children.length; i++) {
      // 递归调用函数，并传递当前路径加上当前dirName
      const foundPath = findDirPathByUuid(
        targetUuid,
        path + (path ? '/' : '') + data.dirName,
        data.children[i]
      )
      if (foundPath) {
        return foundPath // 如果在子对象中找到了，就返回完整的路径
      }
    }
  }

  // 如果没有找到，返回空字符串
  return ''
}
export const reOrderChildren = (children: IDir[]) => {
  for (let index in children) {
    children[index].order = Number(index) + 1
  }
}

export const isDragItemInDirChildren = (targetUUID: string, children?: IDir[]) => {
  if (children === undefined) {
    const runtime = useRuntimeStore()
    children = runtime.dragItemData?.children ?? []
  }
  for (const child of children) {
    if (child.uuid === targetUUID) {
      return true
    }
    if (isDragItemInDirChildren(targetUUID, child.children)) {
      return true
    }
  }
  return false
}

export function getDepthByUuid(targetUuid: string) {
  const runtime = useRuntimeStore()
  let data = runtime.libraryTree
  // 递归函数，用于遍历JSON对象并计算深度
  function traverse(node: IDir, depth = 0): number | undefined {
    // 如果当前节点的UUID与目标UUID匹配，返回当前深度
    if (node.uuid === targetUuid) {
      return depth
    }

    // 遍历子节点
    if (node.children && node.children.length > 0) {
      for (let i = 0; i < node.children.length; i++) {
        // 递归调用traverse函数，深度+1
        let result = traverse(node.children[i], depth + 1)
        // 如果找到了匹配的UUID，则返回结果
        if (result !== undefined) {
          return result
        }
      }
    }

    // 如果没有找到匹配的UUID，返回undefined
    return undefined
  }

  // 从根节点开始遍历
  return traverse(data)
}
//获取平铺的所有子UUID（包括自己）
export function getAllUuids(data: IDir) {
  const uuids: string[] = []
  function traverse(node: IDir) {
    uuids.push(node.uuid)
    if (node.children && node.children.length > 0) {
      node.children.forEach((child) => {
        traverse(child)
      })
    }
  }
  traverse(data)
  return uuids
}

// 更新播放状态
export function updatePlayingState(itemData: IDir): void {
  try {
    const runtime = useRuntimeStore()
    // 不需要查找当前的树，因为可能已被移除，直接使用传入的数据
    const flatUUID = getAllUuids(itemData)

    // 更新当前选中的歌单
    if (flatUUID.includes(runtime.songsArea.songListUUID)) {
      runtime.songsArea.songListUUID = ''
    }

    // 更新正在播放的歌单
    if (flatUUID.includes(runtime.playingData.playingSongListUUID)) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
  } catch (error) {
    console.error('Failed to update playing state:', error)
  }
}

// 导出集合和默认导出（如果其他地方还在用的话，需要恢复）
export const libraryUtils = {
  getFatherLibraryTreeByUUID,
  getLibraryTreeByUUID,
  findDirPathByUuid,
  reOrderChildren,
  isDragItemInDirChildren,
  getDepthByUuid,
  getAllUuids,
  diffLibraryTreeExecuteFileOperation,
  updatePlayingState
}
export default libraryUtils
