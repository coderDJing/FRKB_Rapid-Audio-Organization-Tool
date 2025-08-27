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
    typeof obj.createdAt === 'string'
  )
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
    appVersion
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
