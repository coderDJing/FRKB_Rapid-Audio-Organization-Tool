import fs = require('fs-extra')
import path = require('path')
import { v4 as uuidV4 } from 'uuid'

export const MANIFEST_FILE_NAME = 'FRKB.database.frkbdb'
export const CURRENT_MANIFEST_VERSION = 2

export interface FrkbManifest {
  type: 'frkb_root'
  version: number
  uuid: string
  createdAt: string
  appVersion?: string
  minAppVersion?: string
}

export function getManifestPath(dirPath: string): string {
  return path.join(dirPath, MANIFEST_FILE_NAME)
}

export async function readManifestFile(filePath: string): Promise<FrkbManifest> {
  const data = await fs.readJSON(filePath)
  if (!isValidManifest(data)) {
    throw new Error('Invalid FRKB manifest')
  }
  return data as FrkbManifest
}

export function isValidManifest(obj: any): obj is FrkbManifest {
  return (
    obj &&
    obj.type === 'frkb_root' &&
    typeof obj.version === 'number' &&
    typeof obj.uuid === 'string' &&
    typeof obj.createdAt === 'string' &&
    (obj.minAppVersion === undefined || typeof obj.minAppVersion === 'string')
  )
}

type ParsedVersion = {
  parts: number[]
  prerelease: string | null
}

function parseVersion(version: string): ParsedVersion | null {
  const raw = String(version || '').trim()
  if (!raw) return null
  const main = raw.split('+')[0] || ''
  const [core, pre] = main.split('-', 2)
  const parts = core
    .split('.')
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item))
  if (parts.length === 0) return null
  return {
    parts,
    prerelease: pre && String(pre).trim() ? String(pre).trim() : null
  }
}

export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  const maxLen = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < maxLen; i += 1) {
    const av = pa.parts[i] ?? 0
    const bv = pb.parts[i] ?? 0
    if (av !== bv) return av > bv ? 1 : -1
  }
  if (pa.prerelease && !pb.prerelease) return -1
  if (!pa.prerelease && pb.prerelease) return 1
  if (pa.prerelease && pb.prerelease) {
    if (pa.prerelease === pb.prerelease) return 0
    return pa.prerelease > pb.prerelease ? 1 : -1
  }
  return 0
}

export function isVersionAtLeast(current: string, minimum: string): boolean {
  const cmp = compareVersions(current, minimum)
  if (cmp === null) return true
  return cmp >= 0
}

export function isManifestCompatible(manifest: FrkbManifest, appVersion: string): boolean {
  if (!manifest.minAppVersion) return true
  return isVersionAtLeast(appVersion, manifest.minAppVersion)
}

export async function looksLikeLegacyStructure(dirPath: string): Promise<boolean> {
  try {
    const libDir = path.join(dirPath, 'library')
    const songFpDir = path.join(dirPath, 'songFingerprint')
    const rootDesc = path.join(libDir, '.description.json')
    if (await fs.pathExists(rootDesc)) return true
    if (await fs.pathExists(songFpDir)) return true
    // 简单兜底：library 目录存在也可视作旧库
    if (await fs.pathExists(libDir)) return true
    return false
  } catch (_e) {
    return false
  }
}

export async function writeManifest(dirPath: string, appVersion?: string): Promise<FrkbManifest> {
  const manifest: FrkbManifest = {
    type: 'frkb_root',
    version: CURRENT_MANIFEST_VERSION,
    uuid: uuidV4(),
    createdAt: new Date().toISOString(),
    appVersion,
    minAppVersion: appVersion
  }
  await fs.outputJson(getManifestPath(dirPath), manifest)
  return manifest
}

export async function ensureManifestForLegacy(
  dirPath: string,
  appVersion?: string
): Promise<FrkbManifest | null> {
  const mfPath = getManifestPath(dirPath)
  if (await fs.pathExists(mfPath)) {
    try {
      return await readManifestFile(mfPath)
    } catch (_e) {
      // 如果存在但无效，则不覆盖，交由上层决定
      return null
    }
  }
  const isLegacy = await looksLikeLegacyStructure(dirPath)
  if (!isLegacy) return null
  return await writeManifest(dirPath, appVersion)
}

export async function ensureManifestMinVersion(
  dirPath: string,
  appVersion?: string
): Promise<void> {
  if (!dirPath || !appVersion) return
  const mfPath = getManifestPath(dirPath)
  if (!(await fs.pathExists(mfPath))) return
  let manifest: FrkbManifest | null = null
  try {
    manifest = await readManifestFile(mfPath)
  } catch {
    return
  }
  if (!manifest || manifest.minAppVersion) return
  const updated = { ...manifest, minAppVersion: appVersion }
  await fs.outputJson(mfPath, updated)
}
