import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { resolveInstalledDemucsPlatformRootPath } from '../demucs'
import { createStemError, normalizeText, runProcess } from './mixtapeStemSeparationShared'
import type {
  MixtapeStemRuntimeDownloadState,
  RuntimeAssetEntry
} from './mixtapeStemRuntimeDownload'

type RuntimeInstallProgress = Partial<MixtapeStemRuntimeDownloadState>

type RuntimeInstallDeps = {
  fetchRuntimeAsset: (url: string, init?: RequestInit) => Promise<Response>
  computeFileSha256: (filePath: string) => Promise<string>
  resolveRuntimeDownloadCacheDir: () => string
  resolveRuntimeInstalledVersionPath: (runtimeDir: string) => string
  resolveRuntimeProfileTitle: (profile: RuntimeAssetEntry['profile'] | '') => string
  resolveInstalledRuntimeDir: (runtimeKey: string) => string
  fileExists: (targetPath: string) => Promise<boolean>
  validateInstalledRuntime: (entry: RuntimeAssetEntry, runtimeDir: string) => Promise<void>
  readRuntimeMetaFile: (runtimeDir: string) => Promise<Record<string, unknown> | null>
  cleanupRuntimeDownloadArtifacts: (params: {
    entry: RuntimeAssetEntry
    keepArchiveName?: string
  }) => Promise<void>
  createRuntimeContentHash: (params: {
    platform: string
    profile: string
    runtimeKey: string
    pythonRelativePath: string
    runtimeMeta?: Record<string, unknown> | null
  }) => string
}

const downloadRuntimeArchivePart = async (
  deps: RuntimeInstallDeps,
  params: {
    archiveUrl: string
    archivePath: string
    archiveSha256: string
    archiveSize: number
  },
  onProgress?: (payload: { downloadedBytes: number; totalBytes: number }) => void
) => {
  const response = await deps.fetchRuntimeAsset(params.archiveUrl)
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }
  const expectedBytes = Math.max(
    0,
    Number(response.headers.get('content-length') || 0) || Number(params.archiveSize) || 0
  )
  const writer = fs.createWriteStream(params.archivePath)
  let downloadedBytes = 0
  for await (const chunk of Readable.fromWeb(response.body as unknown as NodeReadableStream)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    downloadedBytes += buffer.byteLength
    if (!writer.write(buffer)) {
      await once(writer, 'drain')
    }
    onProgress?.({
      downloadedBytes,
      totalBytes: expectedBytes
    })
  }
  writer.end()
  await once(writer, 'finish')
  const archiveStat = await fs.promises.stat(params.archivePath)
  if (params.archiveSize > 0 && archiveStat.size !== params.archiveSize) {
    throw new Error(
      `download size mismatch: expected=${params.archiveSize} actual=${archiveStat.size}`
    )
  }
  const archiveSha256 = await deps.computeFileSha256(params.archivePath)
  if (archiveSha256 !== params.archiveSha256) {
    throw new Error(
      `download sha256 mismatch: expected=${params.archiveSha256} actual=${archiveSha256}`
    )
  }
}

const downloadRuntimeArchive = async (
  deps: RuntimeInstallDeps,
  entry: RuntimeAssetEntry,
  archivePath: string,
  onProgress?: (payload: { downloadedBytes: number; totalBytes: number; percent: number }) => void
) => {
  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true })
  const archiveParts = Array.isArray(entry.archiveParts) ? entry.archiveParts : []
  const totalBytes = Math.max(0, Number(entry.archiveSize) || 0)
  if (archiveParts.length > 0) {
    let downloadedBytes = 0
    await fs.promises.rm(archivePath, { force: true }).catch(() => {})
    for (const part of archiveParts.sort((a, b) => Number(a.index) - Number(b.index))) {
      const partPath = `${archivePath}.part-${part.index}`
      await downloadRuntimeArchivePart(
        deps,
        {
          archiveUrl: part.archiveUrl,
          archivePath: partPath,
          archiveSha256: part.archiveSha256,
          archiveSize: part.archiveSize
        },
        (progress) => {
          const nextDownloaded = downloadedBytes + progress.downloadedBytes
          const percent =
            totalBytes > 0
              ? Math.max(0, Math.min(90, Math.round((nextDownloaded / totalBytes) * 90)))
              : 0
          onProgress?.({
            downloadedBytes: nextDownloaded,
            totalBytes,
            percent
          })
        }
      )
      const writer = fs.createWriteStream(archivePath, {
        flags: downloadedBytes > 0 ? 'a' : 'w'
      })
      const reader = fs.createReadStream(partPath)
      for await (const chunk of reader) {
        if (!writer.write(chunk)) {
          await once(writer, 'drain')
        }
      }
      writer.end()
      await once(writer, 'finish')
      downloadedBytes += Number(part.archiveSize) || 0
      await fs.promises.rm(partPath, { force: true }).catch(() => {})
    }
    return
  }
  await downloadRuntimeArchivePart(
    deps,
    {
      archiveUrl: entry.archiveUrl,
      archivePath,
      archiveSha256: entry.archiveSha256,
      archiveSize: entry.archiveSize
    },
    (progress) => {
      const percent =
        totalBytes > 0
          ? Math.max(0, Math.min(90, Math.round((progress.downloadedBytes / totalBytes) * 90)))
          : 0
      onProgress?.({
        downloadedBytes: progress.downloadedBytes,
        totalBytes,
        percent
      })
    }
  )
}

const extractRuntimeArchive = async (archivePath: string, outputDir: string) => {
  await fs.promises.mkdir(outputDir, { recursive: true })
  if (process.platform === 'win32') {
    await runProcess('tar.exe', ['-xf', archivePath, '-C', outputDir], {
      timeoutMs: 30 * 60 * 1000,
      traceLabel: 'mixtape-stem-runtime-extract'
    })
    return
  }
  if (process.platform === 'darwin') {
    await runProcess('ditto', ['-x', '-k', archivePath, outputDir], {
      timeoutMs: 30 * 60 * 1000,
      traceLabel: 'mixtape-stem-runtime-extract'
    })
    return
  }
  await runProcess('unzip', ['-q', archivePath, '-d', outputDir], {
    timeoutMs: 30 * 60 * 1000,
    traceLabel: 'mixtape-stem-runtime-extract'
  })
}

export const installRuntimeFromManifestEntry = async (
  entry: RuntimeAssetEntry,
  deps: RuntimeInstallDeps,
  onState?: (patch: RuntimeInstallProgress) => void
) => {
  const downloadCacheDir = deps.resolveRuntimeDownloadCacheDir()
  const archivePath = path.join(downloadCacheDir, entry.archiveName)
  const platformRoot = resolveInstalledDemucsPlatformRootPath()
  const runtimeDir = deps.resolveInstalledRuntimeDir(entry.runtimeKey)
  const versionPath = deps.resolveRuntimeInstalledVersionPath(runtimeDir)
  const tempExtractRoot = path.join(downloadCacheDir, `extract-${entry.profile}-${Date.now()}`)

  onState?.({
    status: 'downloading',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: 0,
    percent: 0,
    title: deps.resolveRuntimeProfileTitle(entry.profile),
    message: `正在下载 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
    error: ''
  })
  await downloadRuntimeArchive(deps, entry, archivePath, (progress) => {
    onState?.({
      status: 'downloading',
      profile: entry.profile,
      runtimeKey: entry.runtimeKey,
      version: entry.version,
      archiveSize: entry.archiveSize,
      totalBytes: progress.totalBytes || entry.archiveSize,
      downloadedBytes: progress.downloadedBytes,
      percent: progress.percent,
      title: deps.resolveRuntimeProfileTitle(entry.profile),
      message: `正在下载 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
      error: ''
    })
  })
  const archiveStat = await fs.promises.stat(archivePath)
  if (entry.archiveSize > 0 && archiveStat.size !== entry.archiveSize) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包大小校验失败: expected=${entry.archiveSize} actual=${archiveStat.size}`
    )
  }
  const archiveSha256 = await deps.computeFileSha256(archivePath)
  if (archiveSha256 !== entry.archiveSha256) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包哈希校验失败: expected=${entry.archiveSha256} actual=${archiveSha256}`
    )
  }

  await fs.promises.rm(tempExtractRoot, { recursive: true, force: true }).catch(() => {})
  onState?.({
    status: 'extracting',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: entry.archiveSize,
    percent: 94,
    title: deps.resolveRuntimeProfileTitle(entry.profile),
    message: `正在解压 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
    error: ''
  })
  await extractRuntimeArchive(archivePath, tempExtractRoot)
  const extractedRuntimeDir = path.join(tempExtractRoot, entry.runtimeKey)
  const extractedPythonPath = path.join(extractedRuntimeDir, entry.pythonRelativePath)
  if (!(await deps.fileExists(extractedPythonPath))) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包缺少 Python: ${entry.pythonRelativePath}`
    )
  }

  await fs.promises.mkdir(platformRoot, { recursive: true })
  onState?.({
    status: 'extracting',
    percent: 98,
    message: `正在启用 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`
  })
  await fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rename(extractedRuntimeDir, runtimeDir)
  try {
    await deps.validateInstalledRuntime(entry, runtimeDir)
  } catch (error) {
    await fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const runtimeMeta = await deps.readRuntimeMetaFile(runtimeDir)
  await fs.promises.writeFile(
    versionPath,
    `${JSON.stringify(
      {
        profile: entry.profile,
        runtimeKey: entry.runtimeKey,
        version: entry.version,
        archiveUrl: entry.archiveUrl,
        archiveSha256: entry.archiveSha256,
        contentHash:
          normalizeText(entry.contentHash, 120).toLowerCase() ||
          deps.createRuntimeContentHash({
            platform: entry.platform,
            profile: entry.profile,
            runtimeKey: entry.runtimeKey,
            pythonRelativePath: entry.pythonRelativePath,
            runtimeMeta
          }),
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await fs.promises.rm(tempExtractRoot, { recursive: true, force: true }).catch(() => {})
  await deps
    .cleanupRuntimeDownloadArtifacts({
      entry
    })
    .catch(() => {})
  onState?.({
    status: 'ready',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: entry.archiveSize,
    percent: 100,
    title: deps.resolveRuntimeProfileTitle(entry.profile),
    message: `${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件已就绪`,
    error: ''
  })
}
