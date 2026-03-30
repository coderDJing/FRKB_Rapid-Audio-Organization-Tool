import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import {
  createConsoleDownloadProgressReporter,
  fetchWithRuntimeProxy
} from './demucs-runtime-support.mjs'

const DEFAULT_STANDALONE_PYTHON_VERSION = '3.11.15'
const DEFAULT_STANDALONE_RELEASE_TAG = '20260325'
const STANDALONE_VARIANT = 'install_only'

const DARWIN_TARGET_TRIPLE_BY_PLATFORM = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin'
}

const resolveStandaloneArchiveSpec = (platformKey) => {
  const targetTriple = DARWIN_TARGET_TRIPLE_BY_PLATFORM[platformKey]
  if (!targetTriple) {
    throw new Error(`[demucs-runtime-ensure] Unsupported standalone Python platform: ${platformKey}`)
  }
  const pythonVersion =
    String(process.env.FRKB_DEMUCS_STANDALONE_PYTHON_VERSION || '').trim() ||
    DEFAULT_STANDALONE_PYTHON_VERSION
  const releaseTag =
    String(process.env.FRKB_DEMUCS_STANDALONE_RELEASE_TAG || '').trim() ||
    DEFAULT_STANDALONE_RELEASE_TAG
  const assetName = `cpython-${pythonVersion}+${releaseTag}-${targetTriple}-${STANDALONE_VARIANT}.tar.gz`
  return {
    releaseTag,
    pythonVersion,
    targetTriple,
    assetName,
    archiveUrl: `https://github.com/astral-sh/python-build-standalone/releases/download/${releaseTag}/${encodeURIComponent(assetName)}`
  }
}

const downloadArchiveIfNeeded = async ({ archivePath, archiveUrl, assetName }) => {
  if (fs.existsSync(archivePath)) return
  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true })
  const response = await fetchWithRuntimeProxy(archiveUrl, {
    redirect: 'follow'
  })
  if (!response.ok || !response.body) {
    throw new Error(`standalone python download failed: HTTP ${response.status}`)
  }
  const totalBytes = Number(response.headers.get('content-length') || 0)
  const reportProgress = createConsoleDownloadProgressReporter({
    label: `standalone python ${assetName}`,
    totalBytes
  })
  const tempPath = `${archivePath}.tmp-${process.pid}-${Date.now()}`
  const writer = fs.createWriteStream(tempPath)
  let downloadedBytes = 0
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      downloadedBytes += buffer.byteLength
      if (!writer.write(buffer)) {
        await once(writer, 'drain')
      }
      reportProgress({ downloadedBytes })
    }
    writer.end()
    await once(writer, 'finish')
    reportProgress({ downloadedBytes, done: true })
    await fs.promises.rename(tempPath, archivePath)
  } catch (error) {
    writer.destroy()
    await fs.promises.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export const bootstrapPortableDarwinPython = async ({
  platformKey,
  runtimeRoot,
  targetRuntimeDir,
  run
}) => {
  const spec = resolveStandaloneArchiveSpec(platformKey)
  const downloadDir = path.resolve(runtimeRoot, '.downloads', 'python-build-standalone')
  const archivePath = path.join(downloadDir, spec.assetName)
  const extractRoot = path.join(downloadDir, `extract-${spec.targetTriple}-${Date.now()}`)

  await downloadArchiveIfNeeded({
    archivePath,
    archiveUrl: spec.archiveUrl,
    assetName: spec.assetName
  })

  await fs.promises.rm(extractRoot, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(extractRoot, { recursive: true })
  run('tar', ['-xzf', archivePath, '-C', extractRoot])

  const extractedRuntimeDir = path.join(extractRoot, 'python')
  const extractedPythonPath = path.join(extractedRuntimeDir, 'bin', 'python3')
  if (!fs.existsSync(extractedPythonPath)) {
    throw new Error(
      `[demucs-runtime-ensure] Standalone Python archive missing bin/python3: ${spec.assetName}`
    )
  }

  await fs.promises.rm(targetRuntimeDir, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(path.dirname(targetRuntimeDir), { recursive: true })
  try {
    await fs.promises.rename(extractedRuntimeDir, targetRuntimeDir)
  } catch (error) {
    const errorCode = String(error?.code || '')
      .trim()
      .toUpperCase()
    if (!['EPERM', 'EACCES', 'EXDEV', 'EEXIST', 'ENOTEMPTY'].includes(errorCode)) {
      throw error
    }
    await fs.promises.rm(targetRuntimeDir, { recursive: true, force: true }).catch(() => {})
    fs.cpSync(extractedRuntimeDir, targetRuntimeDir, {
      recursive: true,
      force: true
    })
    await fs.promises.rm(extractedRuntimeDir, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fs.promises.rm(extractRoot, { recursive: true, force: true }).catch(() => {})
  }

  return {
    ...spec,
    runtimeDir: targetRuntimeDir,
    pythonPath: path.join(targetRuntimeDir, 'bin', 'python3')
  }
}
