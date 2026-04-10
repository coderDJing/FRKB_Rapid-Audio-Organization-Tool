import path from 'node:path'

const resolveMainBundleRoot = (dirnameValue: string) => {
  const normalizedDir = path.resolve(dirnameValue)
  return path.basename(normalizedDir) === 'chunks'
    ? path.resolve(normalizedDir, '..')
    : normalizedDir
}

export const resolveMainWorkerPath = (dirnameValue: string, workerFileName: string) =>
  path.join(resolveMainBundleRoot(dirnameValue), 'workers', workerFileName)
