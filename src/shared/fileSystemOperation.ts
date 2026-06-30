/**
 * 文件系统操作（跨进程契约）。
 *
 * 由 renderer 计算（见 `@renderer/utils/diffLibraryTree`），经 IPC 通道
 * `operateFileSystemChange` 传给 main 执行。定义在 shared 层，避免 main 反向
 * 依赖 renderer 代码。
 */
export interface FileSystemOperation {
  type: 'create' | 'delete' | 'permanentlyDelete' | 'rename' | 'move' | 'reorder'
  path: string
  newPath?: string
  newName?: string
  order?: number
  oldOrder?: number
  uuid: string
  nodeType?: string
}
