import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import store from '../store'
import { getCoreFsDirName } from '../utils'

const LIBRARY_STEM_CACHE_DIR_NAME = '.frkb_cache'
const LIBRARY_STEM_CACHE_STEMS_DIR_NAME = 'stems'
const MIXTAPE_VAULT_DIR_NAME = '.mixtape_vault'

const normalizeText = (value: unknown, maxLen = 4000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizePath = (value: string): string => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  const resolved = path.resolve(normalized)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function getLibraryRootAbs(): string | null {
  const dbRoot = normalizeText(store.databaseDir)
  if (!dbRoot) return null
  return path.join(dbRoot, 'library')
}

export function getLibraryStemCacheRootAbs(): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  return path.join(libraryRoot, LIBRARY_STEM_CACHE_DIR_NAME, LIBRARY_STEM_CACHE_STEMS_DIR_NAME)
}

export function getMixtapeVaultRootAbs(): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  return path.join(libraryRoot, getCoreFsDirName('MixtapeLibrary'), MIXTAPE_VAULT_DIR_NAME)
}

export function isUnderPath(parentPath: string, targetPath: string): boolean {
  const parent = normalizePath(parentPath)
  const target = normalizePath(targetPath)
  if (!parent || !target) return false
  return target === parent || target.startsWith(parent + path.sep)
}

export function isPathInLibrary(filePath: string): boolean {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return false
  return isUnderPath(libraryRoot, filePath)
}

export function isPathInMixtapeVault(filePath: string): boolean {
  const vaultRoot = getMixtapeVaultRootAbs()
  if (!vaultRoot) return false
  return isUnderPath(vaultRoot, filePath)
}

const hashFileSha256 = async (filePath: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })

export async function computeLibraryStemSourceSignature(filePath: string): Promise<string> {
  const normalized = normalizeText(filePath)
  if (!normalized) return ''
  try {
    const stat = await fs.promises.stat(normalized)
    if (!stat.isFile()) return ''
    const hash = await hashFileSha256(normalized)
    if (!hash) return ''
    return `${hash}:${Math.max(0, Number(stat.size) || 0)}`
  } catch {
    return ''
  }
}

export function toSafeStemPathSegment(value: string, fallback = 'default'): string {
  const cleaned = normalizeText(value, 128)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
  return cleaned || fallback
}

export async function resolveLibraryStemCacheDir(params: {
  filePath?: string
  sourceSignature?: string
  model: string
  stemMode: string
}): Promise<string> {
  const cacheRoot = getLibraryStemCacheRootAbs()
  if (!cacheRoot) return ''
  const sourceSignature =
    normalizeText(params.sourceSignature, 160) ||
    (await computeLibraryStemSourceSignature(normalizeText(params.filePath)))
  if (!sourceSignature) return ''
  return path.join(
    cacheRoot,
    toSafeStemPathSegment(sourceSignature, 'source'),
    toSafeStemPathSegment(params.model, 'htdemucs'),
    toSafeStemPathSegment(params.stemMode, '4stems')
  )
}

export async function removeLibraryStemAssetFiles(
  filePaths: Array<string | null | undefined>
): Promise<void> {
  const normalizedPaths = Array.from(
    new Set(filePaths.map((item) => normalizeText(item)).filter(Boolean))
  )
  if (!normalizedPaths.length) return

  const cacheRoot = getLibraryStemCacheRootAbs()
  const removableDirs = new Set<string>()
  const removableFiles = new Set<string>()
  for (const filePath of normalizedPaths) {
    if (cacheRoot && isUnderPath(cacheRoot, filePath)) {
      removableDirs.add(path.dirname(filePath))
      continue
    }
    removableFiles.add(filePath)
  }

  for (const dirPath of Array.from(removableDirs)) {
    await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {})
  }
  for (const filePath of Array.from(removableFiles)) {
    await fs.promises.rm(filePath, { force: true }).catch(() => {})
  }
}
