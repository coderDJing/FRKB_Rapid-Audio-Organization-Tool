import { app } from 'electron'
import type { ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater'
import fs = require('fs-extra')
import path = require('path')
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import {
  downloadResumableFile,
  downloadedFileMatchesChecksum,
  type ResumableDownloadFetch,
  type ResumableDownloadProgress
} from './resumableHttpDownload'

const MANUAL_UPDATE_DIR_NAME = 'FRKB Updates'

export type ManualMacUpdateAssetKind = 'dmg' | 'pkg' | 'zip' | 'other'

export type ManualMacUpdateAsset = {
  kind: ManualMacUpdateAssetKind
  downloadUrl: string
  fileName: string
  totalBytes: number
  sha512?: string
}

type ManualMacUpdateProgress = {
  percent: number
  bytesPerSecond: number
  transferredBytes: number
  totalBytes: number
  fileName: string
}

export type ManualMacUpdateResult = {
  kind: ManualMacUpdateAssetKind
  filePath: string
  fileName: string
  downloadDir: string
}

const fetchManualUpdateAsset: ResumableDownloadFetch = async (url, init) => {
  const response = await fetchWithSystemProxy(url, {
    headers: init?.headers,
    signal: init?.signal
  })
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: response.body
  }
}

const getAssetKind = (fileName: string): ManualMacUpdateAssetKind => {
  const normalized = String(fileName || '').toLowerCase()
  if (normalized.endsWith('.dmg')) return 'dmg'
  if (normalized.endsWith('.pkg')) return 'pkg'
  if (normalized.endsWith('.zip')) return 'zip'
  return 'other'
}

const getPreferredOrder = (kind: ManualMacUpdateAssetKind): number => {
  switch (kind) {
    case 'dmg':
      return 0
    case 'pkg':
      return 1
    case 'zip':
      return 2
    default:
      return 3
  }
}

const getDownloadDir = () => path.join(app.getPath('downloads'), MANUAL_UPDATE_DIR_NAME)

const getSafeFileNameFromUrl = (input: string): string => {
  try {
    const fileName = path.basename(new URL(input).pathname)
    if (fileName) return fileName
  } catch {}
  return path.basename(String(input || '').split('?')[0]) || `FRKB-update-${Date.now()}`
}

const getUniqueTargetPath = async (downloadDir: string, fileName: string): Promise<string> => {
  const parsed = path.parse(fileName)
  let attempt = 0
  while (true) {
    const suffix = attempt === 0 ? '' : ` (${attempt})`
    const targetPath = path.join(downloadDir, `${parsed.name}${suffix}${parsed.ext}`)
    if (!(await fs.pathExists(targetPath))) {
      return targetPath
    }
    attempt += 1
  }
}

const readAssetSha512 = (value: unknown): string => {
  const sha512 = typeof value === 'string' ? value.trim() : ''
  return sha512
}

const createManualAsset = (
  downloadUrl: string,
  fileName: string,
  totalBytes: number,
  sha512?: string
): ManualMacUpdateAsset => ({
  kind: getAssetKind(fileName),
  downloadUrl,
  fileName,
  totalBytes: Math.max(0, totalBytes),
  ...(sha512 ? { sha512 } : {})
})

const isReusableCompleteFile = async (filePath: string, asset: ManualMacUpdateAsset) => {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size <= 0) return false
    if (asset.totalBytes > 0 && stat.size !== asset.totalBytes) return false
    if (!asset.sha512) return asset.totalBytes > 0
    return await downloadedFileMatchesChecksum(filePath, { sha512: asset.sha512 })
  } catch {
    return false
  }
}

const toManualProgress = (
  payload: ResumableDownloadProgress,
  fileName: string
): ManualMacUpdateProgress => ({
  ...payload,
  fileName
})

export const pickManualMacUpdateAsset = (
  updateInfo: UpdateInfo,
  resolvedFiles: ResolvedUpdateFileInfo[]
): ManualMacUpdateAsset | null => {
  const candidates = (Array.isArray(resolvedFiles) ? resolvedFiles : [])
    .map((entry) => {
      const href = entry?.url?.href
      if (!href) return null
      return createManualAsset(
        href,
        getSafeFileNameFromUrl(href),
        Number(entry?.info?.size) || 0,
        readAssetSha512(entry?.info?.sha512)
      )
    })
    .filter((entry): entry is ManualMacUpdateAsset => !!entry)
    .sort((a, b) => getPreferredOrder(a.kind) - getPreferredOrder(b.kind))

  if (candidates.length > 0) {
    return candidates[0]
  }

  const legacyPath =
    typeof updateInfo?.path === 'string' && /^https?:\/\//i.test(updateInfo.path)
      ? updateInfo.path
      : ''
  if (!legacyPath) return null
  return createManualAsset(
    legacyPath,
    getSafeFileNameFromUrl(legacyPath),
    Number(updateInfo?.files?.[0]?.size) || 0,
    readAssetSha512(updateInfo?.sha512 || updateInfo?.files?.[0]?.sha512)
  )
}

export const downloadManualMacUpdate = async (
  asset: ManualMacUpdateAsset,
  onProgress?: (payload: ManualMacUpdateProgress) => void
): Promise<ManualMacUpdateResult> => {
  const downloadDir = getDownloadDir()
  await fs.ensureDir(downloadDir)
  const preferredTarget = path.join(downloadDir, asset.fileName)
  const tempPath = `${preferredTarget}.download`

  if (await isReusableCompleteFile(preferredTarget, asset)) {
    const totalBytes =
      asset.totalBytes > 0 ? asset.totalBytes : (await fs.stat(preferredTarget)).size
    onProgress?.(
      toManualProgress(
        {
          percent: 100,
          bytesPerSecond: 0,
          transferredBytes: totalBytes,
          totalBytes
        },
        asset.fileName
      )
    )
    return {
      kind: asset.kind,
      filePath: preferredTarget,
      fileName: asset.fileName,
      downloadDir
    }
  }

  await downloadResumableFile(
    {
      url: asset.downloadUrl,
      destinationPath: tempPath,
      expectedSize: asset.totalBytes > 0 ? asset.totalBytes : undefined,
      sha512: asset.sha512,
      onProgress: (payload) => onProgress?.(toManualProgress(payload, asset.fileName))
    },
    { fetch: fetchManualUpdateAsset }
  )

  let targetPath = preferredTarget
  if (await fs.pathExists(targetPath)) {
    targetPath = await getUniqueTargetPath(downloadDir, asset.fileName)
  }
  await fs.move(tempPath, targetPath, { overwrite: false })
  return {
    kind: asset.kind,
    filePath: targetPath,
    fileName: asset.fileName,
    downloadDir
  }
}
