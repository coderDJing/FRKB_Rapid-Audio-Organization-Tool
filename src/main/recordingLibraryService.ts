import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { getCoreFsDirName } from './coreLibraries'

const RECORDING_FILE_PREFIX = 'FRKB Recording'
const RECORDING_FILE_EXT = '.wav'

const pad2 = (value: number) => String(value).padStart(2, '0')

export function getRecordingLibraryRootAbs(): string | null {
  const rootDir = store.databaseDir
  if (!rootDir) return null
  return path.join(rootDir, 'library', getCoreFsDirName('RecordingLibrary'))
}

export function isInRecordingLibraryAbsPath(absPath: string): boolean {
  const root = getRecordingLibraryRootAbs()
  if (!root || !absPath) return false
  const rel = path.relative(root, path.resolve(absPath))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

export async function ensureRecordingLibraryRoot(): Promise<string> {
  const root = getRecordingLibraryRootAbs()
  if (!root) {
    throw new Error('database directory is not ready')
  }
  await fs.ensureDir(root)
  return root
}

export async function createRecordingOutputPath(now = new Date()): Promise<string> {
  const root = await ensureRecordingLibraryRoot()
  const stamp = [now.getFullYear(), pad2(now.getMonth() + 1), pad2(now.getDate())].join('-')
  const time = [pad2(now.getHours()), pad2(now.getMinutes()), pad2(now.getSeconds())].join('-')
  const baseName = `${RECORDING_FILE_PREFIX} ${stamp} ${time}`
  let candidate = path.join(root, `${baseName}${RECORDING_FILE_EXT}`)
  let suffix = 2
  while (await fs.pathExists(candidate)) {
    candidate = path.join(root, `${baseName} ${suffix}${RECORDING_FILE_EXT}`)
    suffix += 1
  }
  return candidate
}

export async function listRecordingFiles(): Promise<string[]> {
  const root = getRecordingLibraryRootAbs()
  if (!root || !(await fs.pathExists(root))) return []
  let entries: fs.Dirent[] = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(
      (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === RECORDING_FILE_EXT
    )
    .map((entry) => path.join(root, entry.name))
}

export async function hasRecordings(): Promise<boolean> {
  const files = await listRecordingFiles()
  return files.length > 0
}
