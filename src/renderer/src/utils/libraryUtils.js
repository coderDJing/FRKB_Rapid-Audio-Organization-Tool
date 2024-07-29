//根据UUID寻找LibraryTree中对应的对象的父级对象
export const getFatherLibraryTreeByUUID = (data, targetUuid) => {
  // 定义一个辅助函数来递归搜索子对象
  function searchChildren(children, targetUuid, parent = null) {
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
  // 调用辅助函数开始搜索
  return searchChildren(data.children, targetUuid, data) // 初始调用时，parent 为根对象本身
}

//根据UUID寻找LibraryTree中对应的对象
export const getLibraryTreeByUUID = (libraryTree, uuid) => {
  // 如果当前对象就是要找的对象，直接返回
  if (libraryTree.uuid === uuid) {
    return libraryTree
  }

  // 遍历子对象
  if (libraryTree.children && libraryTree.children.length > 0) {
    for (let i = 0; i < libraryTree.children.length; i++) {
      // 递归调用函数
      const found = getLibraryTreeByUUID(libraryTree.children[i], uuid)
      if (found) {
        return found // 如果在子对象中找到了，就返回
      }
    }
  }
  // 如果没有找到，返回null
  return null
}

//根据UUID寻找LibraryTree中对应的对象的路径
export const findDirPathByUuid = (data, targetUuid, path = '') => {
  // 如果当前对象的uuid就是要找的uuid，返回当前路径
  if (data.uuid === targetUuid) {
    return path + (path ? '/' : '') + data.dirName // 加上根目录的dirName（如果有的话）
  }

  // 遍历子对象
  if (data.children && data.children.length > 0) {
    for (let i = 0; i < data.children.length; i++) {
      // 递归调用函数，并传递当前路径加上当前dirName
      const foundPath = findDirPathByUuid(
        data.children[i],
        targetUuid,
        path + (path ? '/' : '') + data.dirName
      )
      if (foundPath) {
        return foundPath // 如果在子对象中找到了，就返回完整的路径
      }
    }
  }

  // 如果没有找到，返回null
  return null
}
export const sortByOrder = (array) => {
  array.sort((a, b) => {
    if (a.order < b.order) {
      return -1
    }
    if (a.order > b.order) {
      return 1
    }
    return 0
  })
}
export const reOrderChildren = (children) => {
  for (let index in children) {
    children[index].order = Number(index) + 1
  }
}

export const isDragItemInDirChildren = (children, targetUUID) => {
  for (const child of children) {
    if (child.uuid === targetUUID) {
      return true
    }
    if (isDragItemInDirChildren(child.children, targetUUID)) {
      return true
    }
  }
  return false
}

export function getDepthByUuid(data, targetUuid) {
  // 递归函数，用于遍历JSON对象并计算深度
  function traverse(node, depth = 0) {
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
export function getAllUuids(data) {
  const uuids = []
  function traverse(node) {
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
export const libraryUtils = {
  getFatherLibraryTreeByUUID,
  getLibraryTreeByUUID,
  findDirPathByUuid,
  sortByOrder,
  reOrderChildren,
  isDragItemInDirChildren,
  getDepthByUuid,
  getAllUuids
}
export default libraryUtils
