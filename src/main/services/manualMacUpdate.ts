import { app } from 'electron'
import type { ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater'
import { once } from 'events'
import { Readable } from 'stream'
import fs = require('fs-extra')
import path = require('path')

const MANUAL_UPDATE_DIR_NAME = 'FRKB Updates'

export type ManualMacUpdateAssetKind = 'dmg' | 'pkg' | 'zip' | 'other'

export type ManualMacUpdateAsset = {
  kind: ManualMacUpdateAssetKind
  downloadUrl: string
  fileName: string
  totalBytes: number
}

export type ManualMacUpdateProgress = {
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

export const pickManualMacUpdateAsset = (
  updateInfo: UpdateInfo,
  resolvedFiles: ResolvedUpdateFileInfo[]
): ManualMacUpdateAsset | null => {
  const candidates = (Array.isArray(resolvedFiles) ? resolvedFiles : [])
    .map((entry) => {
      const href = entry?.url?.href
      if (!href) return null
      const fileName = getSafeFileNameFromUrl(href)
      return {
        kind: getAssetKind(fileName),
        downloadUrl: href,
        fileName,
        totalBytes: Math.max(0, Number(entry?.info?.size) || 0)
      } satisfies ManualMacUpdateAsset
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
  const fileName = getSafeFileNameFromUrl(legacyPath)
  return {
    kind: getAssetKind(fileName),
    downloadUrl: legacyPath,
    fileName,
    totalBytes: Math.max(0, Number(updateInfo?.files?.[0]?.size) || 0)
  }
}

export const downloadManualMacUpdate = async (
  asset: ManualMacUpdateAsset,
  onProgress?: (payload: ManualMacUpdateProgress) => void
): Promise<ManualMacUpdateResult> => {
  const downloadDir = getDownloadDir()
  await fs.ensureDir(downloadDir)
  const targetPath = await getUniqueTargetPath(downloadDir, asset.fileName)
  const tempPath = `${targetPath}.download`
  await fs.remove(tempPath).catch(() => {})

  try {
    const response = await fetch(asset.downloadUrl)
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`)
    }

    const totalBytes =
      Math.max(0, Number(response.headers.get('content-length') || 0) || 0) || asset.totalBytes
    const writer = fs.createWriteStream(tempPath)
    let transferredBytes = 0
    const startedAt = Date.now()

    for await (const chunk of Readable.fromWeb(response.body as any)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      transferredBytes += buffer.byteLength
      if (!writer.write(buffer)) {
        await once(writer, 'drain')
      }
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000)
      const percent =
        totalBytes > 0 ? Math.max(0, Math.min(100, (transferredBytes / totalBytes) * 100)) : 0
      onProgress?.({
        percent,
        bytesPerSecond: transferredBytes / elapsedSeconds,
        transferredBytes,
        totalBytes,
        fileName: asset.fileName
      })
    }

    writer.end()
    await once(writer, 'finish')

    const stat = await fs.stat(tempPath)
    if (totalBytes > 0 && stat.size !== totalBytes) {
      throw new Error(`download size mismatch: expected=${totalBytes} actual=${stat.size}`)
    }

    await fs.move(tempPath, targetPath, { overwrite: false })
    return {
      kind: asset.kind,
      filePath: targetPath,
      fileName: asset.fileName,
      downloadDir
    }
  } catch (error) {
    await fs.remove(tempPath).catch(() => {})
    throw error
  }
}
