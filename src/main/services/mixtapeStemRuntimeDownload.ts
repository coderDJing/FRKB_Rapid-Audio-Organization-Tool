import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { app } from 'electron'
import { ProxyAgent } from 'undici'
import {
  resolveBundledDemucsRuntimeCandidates,
  resolveDemucsPlatformDir,
  resolveInstalledDemucsPlatformRootPath
} from '../demucs'
import { log } from '../log'
import { getSystemProxy } from '../utils'
import mixtapeWindow from '../window/mixtapeWindow'
import { createStemError, normalizeText, runProcess } from './mixtapeStemSeparationShared'
import { probeWindowsGpuAdapters } from './mixtapeStemSeparationProbe'

const DEFAULT_DEMUCS_RUNTIME_MANIFEST_URL =
  'https://github.com/coderDjing/FRKB_Rapid-Audio-Organization-Tool/releases/download/demucs-runtime-assets/demucs-runtime-manifest.json'

type RuntimeProfileName = 'cuda' | 'xpu' | 'directml' | 'cpu' | 'mps' | 'rocm'

type RuntimeAssetEntry = {
  platform: string
  profile: RuntimeProfileName
  runtimeKey: string
  version: string
  archiveName: string
  archiveUrl: string
  archiveSha256: string
  archiveSize: number
  archiveParts?: Array<{
    index: number
    archiveName: string
    archiveUrl: string
    archiveSha256: string
    archiveSize: number
  }>
  pythonRelativePath: string
  generatedAt: string
  torchVersion?: string
}

type RuntimeAssetManifest = {
  schemaVersion: number
  generatedAt: string
  releaseTag: string
  assets: RuntimeAssetEntry[]
}

type InstalledRuntimeVersionInfo = {
  profile?: string
  runtimeKey?: string
  version?: string
  archiveUrl?: string
  archiveSha256?: string
  installedAt?: string
}

export type MixtapeStemRuntimeDownloadState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  profile: RuntimeProfileName | ''
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

export type MixtapeStemRuntimeDownloadInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: RuntimeProfileName | ''
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  state: MixtapeStemRuntimeDownloadState
}

let runtimeManifestPromise: Promise<RuntimeAssetManifest | null> | null = null
const runtimeEnsurePromiseByProfile = new Map<string, Promise<boolean>>()
let runtimeDownloadProxyDispatcher: ProxyAgent | undefined
let runtimeDownloadProxyInitialized = false
let runtimeDownloadState: MixtapeStemRuntimeDownloadState = {
  status: 'idle',
  profile: '',
  runtimeKey: '',
  version: '',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  title: '',
  message: '',
  error: '',
  updatedAt: Date.now()
}

const resolveRuntimeManifestUrl = () =>
  normalizeText(process.env.FRKB_DEMUCS_RUNTIME_MANIFEST_URL, 2000) ||
  DEFAULT_DEMUCS_RUNTIME_MANIFEST_URL

const resolveRuntimeProfileTitle = (profile: RuntimeProfileName | '') => {
  if (profile === 'cuda') return 'NVIDIA CUDA'
  if (profile === 'xpu') return 'Intel Arc XPU'
  if (profile === 'directml') return 'AMD / DirectML'
  if (profile === 'mps') return 'Apple Metal'
  if (profile === 'rocm') return 'AMD ROCm'
  return 'CPU'
}

const resolveRuntimeDownloadCacheDir = () =>
  path.join(app.getPath('userData'), 'demucs-runtime-downloads')

const resolveRuntimeInstalledVersionPath = (runtimeDir: string) =>
  path.join(runtimeDir, '.frkb-runtime-download.json')

const ensureRuntimeDownloadProxyInitialized = async () => {
  if (runtimeDownloadProxyInitialized) return
  runtimeDownloadProxyInitialized = true

  const proxyUrl = await getSystemProxy()
  if (proxyUrl) {
    runtimeDownloadProxyDispatcher = new ProxyAgent(proxyUrl)
  }
}

const fetchRuntimeAsset = async (url: string, init?: RequestInit) => {
  await ensureRuntimeDownloadProxyInitialized()
  const requestInit: RequestInit & { dispatcher?: ProxyAgent } = {
    ...init
  }
  if (runtimeDownloadProxyDispatcher) {
    requestInit.dispatcher = runtimeDownloadProxyDispatcher
  }
  return await fetch(url, requestInit)
}

const fileExists = async (targetPath: string) => {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

const computeFileSha256 = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const emitRuntimeDownloadState = () => {
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-runtime-download-state', {
      ...runtimeDownloadState
    })
  } catch {}
}

const updateRuntimeDownloadState = (
  patch: Partial<MixtapeStemRuntimeDownloadState>
): MixtapeStemRuntimeDownloadState => {
  runtimeDownloadState = {
    ...runtimeDownloadState,
    ...patch,
    updatedAt: Date.now()
  }
  emitRuntimeDownloadState()
  return runtimeDownloadState
}

export const getStemRuntimeDownloadState = (): MixtapeStemRuntimeDownloadState => ({
  ...runtimeDownloadState
})

const readRuntimeManifest = async (): Promise<RuntimeAssetManifest | null> => {
  if (runtimeManifestPromise) return await runtimeManifestPromise
  runtimeManifestPromise = (async () => {
    const manifestUrl = resolveRuntimeManifestUrl()
    try {
      const response = await fetchRuntimeAsset(manifestUrl, {
        headers: {
          Accept: 'application/json'
        }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const manifest = (await response.json()) as RuntimeAssetManifest
      if (!manifest || !Array.isArray(manifest.assets)) {
        throw new Error('manifest assets missing')
      }
      return manifest
    } catch (error) {
      log.warn('[mixtape-stem] runtime manifest fetch failed', {
        manifestUrl,
        error: normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
      })
      return null
    }
  })().finally(() => {
    runtimeManifestPromise = null
  })
  return await runtimeManifestPromise
}

const resolvePreferredRuntimeProfiles = async (): Promise<RuntimeProfileName[]> => {
  if (process.platform === 'win32') {
    const adapters = await probeWindowsGpuAdapters()
    if (adapters.hasNvidia) return ['cuda', 'cpu']
    if (adapters.hasIntel) return ['xpu', 'cpu']
    if (adapters.hasAmd) return ['directml', 'cpu']
    return ['cpu']
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? ['mps', 'cpu'] : ['cpu']
  }
  return []
}

const resolveInstalledRuntimeDir = (runtimeKey: string) =>
  path.join(resolveInstalledDemucsPlatformRootPath(), runtimeKey)

const cleanupRuntimeDownloadArtifacts = async (params: {
  entry: RuntimeAssetEntry
  keepArchiveName?: string
}) => {
  const downloadCacheDir = resolveRuntimeDownloadCacheDir()
  if (!(await fileExists(downloadCacheDir))) return
  const archivePrefix = `frkb-demucs-runtime-${params.entry.platform}-${params.entry.profile}-`
  const keepArchiveName = normalizeText(params.keepArchiveName, 260)
  const dirEntries = await fs.promises
    .readdir(downloadCacheDir, { withFileTypes: true })
    .catch(() => [])
  await Promise.all(
    dirEntries.map(async (entry) => {
      const entryName = normalizeText(entry.name, 260)
      if (!entryName) return
      const absolutePath = path.join(downloadCacheDir, entry.name)
      if (entry.isDirectory()) {
        if (!entryName.startsWith(`extract-${params.entry.profile}-`)) return
        await fs.promises.rm(absolutePath, { recursive: true, force: true }).catch(() => {})
        return
      }
      if (!entryName.startsWith(archivePrefix)) return
      if (keepArchiveName && entryName === keepArchiveName) return
      if (
        keepArchiveName &&
        (entryName === `${keepArchiveName}.part-1` ||
          entryName.startsWith(`${keepArchiveName}.part-`))
      ) {
        return
      }
      await fs.promises.rm(absolutePath, { force: true }).catch(() => {})
    })
  )
}

const readInstalledRuntimeVersionInfo = async (
  runtimeDir: string
): Promise<InstalledRuntimeVersionInfo | null> => {
  const versionPath = resolveRuntimeInstalledVersionPath(runtimeDir)
  if (!(await fileExists(versionPath))) return null
  try {
    const installedRaw = await fs.promises.readFile(versionPath, 'utf8')
    const installed = JSON.parse(installedRaw) as InstalledRuntimeVersionInfo
    return installed && typeof installed === 'object' ? installed : null
  } catch {
    return null
  }
}

const doesInstalledRuntimeMatchEntry = (
  installed: InstalledRuntimeVersionInfo | null,
  entry: RuntimeAssetEntry
) => {
  if (!installed) return false
  const installedRuntimeKey = normalizeText(installed.runtimeKey, 120)
  const installedProfile = normalizeText(installed.profile, 120)
  const installedVersion = normalizeText(installed.version, 120)
  const installedArchiveSha256 = normalizeText(installed.archiveSha256, 120).toLowerCase()
  if (installedRuntimeKey && installedRuntimeKey !== entry.runtimeKey) return false
  if (installedProfile && installedProfile !== entry.profile) return false
  if (installedVersion !== entry.version) return false
  if (
    installedArchiveSha256 !==
    String(entry.archiveSha256 || '')
      .trim()
      .toLowerCase()
  )
    return false
  return true
}

const isRuntimeAlreadyAvailable = async (entry: RuntimeAssetEntry) => {
  const candidate = resolveBundledDemucsRuntimeCandidates().find(
    (item) => item.key === entry.runtimeKey
  )
  if (candidate?.pythonPath && fs.existsSync(candidate.pythonPath)) {
    if (candidate.runtimeDir.startsWith(resolveInstalledDemucsPlatformRootPath())) {
      const installed = await readInstalledRuntimeVersionInfo(candidate.runtimeDir)
      if (doesInstalledRuntimeMatchEntry(installed, entry)) return true
    } else {
      return true
    }
  }
  return false
}

const downloadRuntimeArchivePart = async (
  params: {
    archiveUrl: string
    archivePath: string
    archiveSha256: string
    archiveSize: number
  },
  onProgress?: (payload: { downloadedBytes: number; totalBytes: number }) => void
) => {
  const response = await fetchRuntimeAsset(params.archiveUrl)
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }
  const expectedBytes = Math.max(
    0,
    Number(response.headers.get('content-length') || 0) || Number(params.archiveSize) || 0
  )
  const writer = fs.createWriteStream(params.archivePath)
  let downloadedBytes = 0
  for await (const chunk of Readable.fromWeb(response.body as any)) {
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
  const archiveSha256 = await computeFileSha256(params.archivePath)
  if (archiveSha256 !== params.archiveSha256) {
    throw new Error(
      `download sha256 mismatch: expected=${params.archiveSha256} actual=${archiveSha256}`
    )
  }
}

const downloadRuntimeArchive = async (
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

const installRuntimeFromManifestEntry = async (
  entry: RuntimeAssetEntry,
  onState?: (patch: Partial<MixtapeStemRuntimeDownloadState>) => void
) => {
  const downloadCacheDir = resolveRuntimeDownloadCacheDir()
  const archivePath = path.join(downloadCacheDir, entry.archiveName)
  const platformRoot = resolveInstalledDemucsPlatformRootPath()
  const runtimeDir = resolveInstalledRuntimeDir(entry.runtimeKey)
  const versionPath = resolveRuntimeInstalledVersionPath(runtimeDir)
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
    title: resolveRuntimeProfileTitle(entry.profile),
    message: `正在下载 ${resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
    error: ''
  })
  await downloadRuntimeArchive(entry, archivePath, (progress) => {
    onState?.({
      status: 'downloading',
      profile: entry.profile,
      runtimeKey: entry.runtimeKey,
      version: entry.version,
      archiveSize: entry.archiveSize,
      totalBytes: progress.totalBytes || entry.archiveSize,
      downloadedBytes: progress.downloadedBytes,
      percent: progress.percent,
      title: resolveRuntimeProfileTitle(entry.profile),
      message: `正在下载 ${resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
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
  const archiveSha256 = await computeFileSha256(archivePath)
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
    title: resolveRuntimeProfileTitle(entry.profile),
    message: `正在解压 ${resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
    error: ''
  })
  await extractRuntimeArchive(archivePath, tempExtractRoot)
  const extractedRuntimeDir = path.join(tempExtractRoot, entry.runtimeKey)
  const extractedPythonPath = path.join(extractedRuntimeDir, entry.pythonRelativePath)
  if (!(await fileExists(extractedPythonPath))) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包缺少 Python: ${entry.pythonRelativePath}`
    )
  }

  await fs.promises.mkdir(platformRoot, { recursive: true })
  onState?.({
    status: 'extracting',
    percent: 98,
    message: `正在启用 ${resolveRuntimeProfileTitle(entry.profile)} 加速组件`
  })
  await fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rename(extractedRuntimeDir, runtimeDir)
  await fs.promises.writeFile(
    versionPath,
    `${JSON.stringify(
      {
        profile: entry.profile,
        runtimeKey: entry.runtimeKey,
        version: entry.version,
        archiveUrl: entry.archiveUrl,
        archiveSha256: entry.archiveSha256,
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await fs.promises.rm(tempExtractRoot, { recursive: true, force: true }).catch(() => {})
  await cleanupRuntimeDownloadArtifacts({
    entry
  }).catch(() => {})
  onState?.({
    status: 'ready',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: entry.archiveSize,
    percent: 100,
    title: resolveRuntimeProfileTitle(entry.profile),
    message: `${resolveRuntimeProfileTitle(entry.profile)} 加速组件已就绪`,
    error: ''
  })
}

const ensureRuntimeProfileAvailable = async (
  profile: RuntimeProfileName,
  options?: {
    emitState?: boolean
  }
): Promise<boolean> => {
  const platform = resolveDemucsPlatformDir()
  const promiseKey = `${platform}:${profile}`
  const existing = runtimeEnsurePromiseByProfile.get(promiseKey)
  if (existing) return await existing

  const task = (async () => {
    const manifest = await readRuntimeManifest()
    if (!manifest) return false
    const entry =
      manifest.assets.find((item) => item.platform === platform && item.profile === profile) || null
    if (!entry) return false
    if (await isRuntimeAlreadyAvailable(entry)) {
      if (options?.emitState) {
        updateRuntimeDownloadState({
          status: 'ready',
          profile: entry.profile,
          runtimeKey: entry.runtimeKey,
          version: entry.version,
          archiveSize: entry.archiveSize,
          totalBytes: entry.archiveSize,
          downloadedBytes: entry.archiveSize,
          percent: 100,
          title: resolveRuntimeProfileTitle(entry.profile),
          message: `${resolveRuntimeProfileTitle(entry.profile)} 加速组件已就绪`,
          error: ''
        })
      }
      return true
    }
    try {
      log.info('[mixtape-stem] downloading runtime asset', {
        profile: entry.profile,
        runtimeKey: entry.runtimeKey,
        version: entry.version,
        archiveUrl: entry.archiveUrl
      })
      await installRuntimeFromManifestEntry(
        entry,
        options?.emitState ? updateRuntimeDownloadState : undefined
      )
      log.info('[mixtape-stem] runtime asset installed', {
        profile: entry.profile,
        runtimeKey: entry.runtimeKey,
        version: entry.version
      })
      return true
    } catch (error) {
      if (options?.emitState) {
        updateRuntimeDownloadState({
          status: 'failed',
          profile: entry.profile,
          runtimeKey: entry.runtimeKey,
          version: entry.version,
          archiveSize: entry.archiveSize,
          title: resolveRuntimeProfileTitle(entry.profile),
          message: `${resolveRuntimeProfileTitle(entry.profile)} 加速组件下载失败`,
          error: normalizeText(error instanceof Error ? error.message : String(error || ''), 500)
        })
      }
      log.warn('[mixtape-stem] runtime asset install failed', {
        profile: entry.profile,
        runtimeKey: entry.runtimeKey,
        version: entry.version,
        error: normalizeText(error instanceof Error ? error.message : String(error || ''), 500)
      })
      return false
    }
  })().finally(() => {
    runtimeEnsurePromiseByProfile.delete(promiseKey)
  })
  runtimeEnsurePromiseByProfile.set(promiseKey, task)
  return await task
}

export const getPreferredStemRuntimeDownloadInfo =
  async (): Promise<MixtapeStemRuntimeDownloadInfo> => {
    const preferredProfiles = await resolvePreferredRuntimeProfiles()
    if (preferredProfiles.length === 0) {
      return {
        supported: false,
        downloadable: false,
        alreadyAvailable: false,
        profile: '',
        runtimeKey: '',
        version: '',
        archiveSize: 0,
        title: '',
        reason: 'platform unsupported',
        manifestUrl: resolveRuntimeManifestUrl(),
        releaseTag: '',
        state: getStemRuntimeDownloadState()
      }
    }
    const manifest = await readRuntimeManifest()
    if (!manifest) {
      return {
        supported: true,
        downloadable: false,
        alreadyAvailable: false,
        profile: preferredProfiles[0] || '',
        runtimeKey: '',
        version: '',
        archiveSize: 0,
        title: resolveRuntimeProfileTitle(preferredProfiles[0] || ''),
        reason: 'manifest unavailable',
        manifestUrl: resolveRuntimeManifestUrl(),
        releaseTag: '',
        state: getStemRuntimeDownloadState()
      }
    }
    const platform = resolveDemucsPlatformDir()
    const entry =
      preferredProfiles
        .map(
          (profile) =>
            manifest.assets.find(
              (item) => item.platform === platform && item.profile === profile
            ) || null
        )
        .find(Boolean) || null
    if (!entry) {
      return {
        supported: true,
        downloadable: false,
        alreadyAvailable: false,
        profile: preferredProfiles[0] || '',
        runtimeKey: '',
        version: '',
        archiveSize: 0,
        title: resolveRuntimeProfileTitle(preferredProfiles[0] || ''),
        reason: 'runtime asset missing',
        manifestUrl: resolveRuntimeManifestUrl(),
        releaseTag: manifest.releaseTag || '',
        state: getStemRuntimeDownloadState()
      }
    }
    const alreadyAvailable = await isRuntimeAlreadyAvailable(entry)
    return {
      supported: true,
      downloadable: !alreadyAvailable,
      alreadyAvailable,
      profile: entry.profile,
      runtimeKey: entry.runtimeKey,
      version: entry.version,
      archiveSize: entry.archiveSize,
      title: resolveRuntimeProfileTitle(entry.profile),
      reason: alreadyAvailable ? 'already available' : '',
      manifestUrl: resolveRuntimeManifestUrl(),
      releaseTag: manifest.releaseTag || '',
      state: getStemRuntimeDownloadState()
    }
  }

export const downloadPreferredStemRuntime = async (): Promise<boolean> => {
  const info = await getPreferredStemRuntimeDownloadInfo()
  if (!info.supported || !info.profile) return false
  if (info.alreadyAvailable) {
    updateRuntimeDownloadState({
      status: 'ready',
      profile: info.profile,
      runtimeKey: info.runtimeKey,
      version: info.version,
      archiveSize: info.archiveSize,
      totalBytes: info.archiveSize,
      downloadedBytes: info.archiveSize,
      percent: 100,
      title: info.title,
      message: `${info.title} 加速组件已就绪`,
      error: ''
    })
    return true
  }
  updateRuntimeDownloadState({
    status: 'available',
    profile: info.profile,
    runtimeKey: info.runtimeKey,
    version: info.version,
    archiveSize: info.archiveSize,
    totalBytes: info.archiveSize,
    downloadedBytes: 0,
    percent: 0,
    title: info.title,
    message: `${info.title} 加速组件可下载`,
    error: ''
  })
  return await ensureRuntimeProfileAvailable(info.profile, {
    emitState: true
  })
}
