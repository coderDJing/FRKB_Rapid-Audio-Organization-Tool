import fs from 'fs-extra'
import type { Stats } from 'node:fs'
import path from 'node:path'
import {
  LIBRARY_RELOCATE_SPACE_MARGIN_BYTES,
  LibraryRelocateError,
  type LibraryRelocatePreview
} from './types'
import { pathsEqual } from './paths'
import {
  assertNotNestedRelocate,
  collectLibraryInventory,
  findLibraryRootUpwards,
  getAvailableBytes,
  isFrkbLibraryRoot,
  isSameVolume
} from './inventory'

export type LibraryRelocatePreflightOptions = {
  sourcePath: string
  parentPath: string
  resumeDestPath?: string | null
}

export const buildRelocateDestPath = (parentPath: string, sourcePath: string): string =>
  path.join(path.resolve(parentPath), path.basename(path.resolve(sourcePath)))

export const previewLibraryRelocate = async (
  options: LibraryRelocatePreflightOptions
): Promise<LibraryRelocatePreview> => {
  const sourcePath = path.resolve(String(options.sourcePath || '').trim())
  const parentPath = path.resolve(String(options.parentPath || '').trim())
  if (!sourcePath) {
    throw new LibraryRelocateError('SOURCE_NOT_READY', '当前 FRKB 库路径无效')
  }
  if (!(await fs.pathExists(sourcePath))) {
    throw new LibraryRelocateError('SOURCE_NOT_READY', '当前 FRKB 库不存在或无法访问')
  }
  if (!(await isFrkbLibraryRoot(sourcePath))) {
    throw new LibraryRelocateError('SOURCE_NOT_READY', '当前路径不是有效的 FRKB 库')
  }

  let parentStat: Stats | null = null
  try {
    parentStat = await fs.stat(parentPath)
  } catch {
    throw new LibraryRelocateError('PARENT_MISSING', '所选父目录不存在或无法访问')
  }
  if (!parentStat.isDirectory()) {
    throw new LibraryRelocateError('PARENT_NOT_DIRECTORY', '请选择一个文件夹作为新位置的父目录')
  }

  if (await isFrkbLibraryRoot(parentPath)) {
    throw new LibraryRelocateError(
      'PARENT_IS_LIBRARY',
      '所选目录已经是 FRKB 库，不能作为目标父目录'
    )
  }
  const enclosingRoot = await findLibraryRootUpwards(parentPath)
  if (enclosingRoot) {
    throw new LibraryRelocateError(
      'PARENT_INSIDE_LIBRARY',
      '所选目录位于某个 FRKB 库内部，请选择库外的位置'
    )
  }

  const folderName = path.basename(sourcePath)
  const destPath = buildRelocateDestPath(parentPath, sourcePath)
  const nestedCode = assertNotNestedRelocate(sourcePath, destPath, parentPath)
  if (nestedCode === 'SAME_PATH') {
    throw new LibraryRelocateError('SAME_PATH', '新位置与当前 FRKB 库相同')
  }
  if (nestedCode === 'NESTED_PATH') {
    throw new LibraryRelocateError('NESTED_PATH', '不能把 FRKB 库移动到自己内部')
  }

  const destExists = await fs.pathExists(destPath)
  const resumeDest = String(options.resumeDestPath || '').trim()
  const isResumeDest = !!resumeDest && pathsEqual(destPath, resumeDest)
  if (destExists && !isResumeDest) {
    throw new LibraryRelocateError('DEST_EXISTS', `目标目录已存在：${destPath}`)
  }

  const inventory = await collectLibraryInventory(sourcePath)
  const sameVolume = await isSameVolume(sourcePath, parentPath)
  if (!sameVolume) {
    const available = await getAvailableBytes(parentPath)
    if (available === null) {
      throw new LibraryRelocateError('SPACE_UNAVAILABLE', '无法检查目标磁盘剩余空间')
    }
    const required = inventory.totalBytes + LIBRARY_RELOCATE_SPACE_MARGIN_BYTES
    if (available < required) {
      throw new LibraryRelocateError('INSUFFICIENT_SPACE', '目标磁盘剩余空间不足', {
        requiredBytes: required,
        availableBytes: available
      })
    }
  }

  return {
    sourcePath,
    destPath,
    parentPath,
    folderName,
    totalBytes: inventory.totalBytes,
    totalFiles: inventory.files.length,
    sameVolume
  }
}
