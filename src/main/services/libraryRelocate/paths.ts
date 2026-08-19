import path from 'node:path'

export const normalizeFsPath = (value: string): string => {
  const resolved = path.resolve(String(value || '').trim())
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const pathsEqual = (left: string, right: string): boolean =>
  normalizeFsPath(left) === normalizeFsPath(right)

export const isPathInside = (child: string, parent: string): boolean => {
  const childPath = normalizeFsPath(child)
  const parentPath = normalizeFsPath(parent)
  if (childPath === parentPath) return false
  const relative = path.relative(parentPath, childPath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export const toRelativePathKey = (root: string, absPath: string): string => {
  const relative = path.relative(root, absPath)
  const normalized = relative.split(path.sep).join('/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
