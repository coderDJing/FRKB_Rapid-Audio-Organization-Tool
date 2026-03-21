import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const packageJsonPath = path.resolve('./package.json')

const runtimeProfiles = JSON.parse(fs.readFileSync(runtimeProfilesPath, 'utf8'))
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

const args = process.argv.slice(2)

const getArgValue = (flag, fallback = '') => {
  const directPrefix = `${flag}=`
  const direct = args.find((arg) => arg.startsWith(directPrefix))
  if (direct) return direct.slice(directPrefix.length).trim()
  const index = args.findIndex((arg) => arg === flag)
  if (index >= 0) {
    const next = args[index + 1]
    return typeof next === 'string' ? next.trim() : ''
  }
  return fallback
}

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const platformDefault = (() => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
})()

const runtimeRoot = path.resolve(getArgValue('--runtime-root', 'vendor/demucs'))
const platformKey = getArgValue('--platform', platformDefault)
const outputRoot = path.resolve(getArgValue('--output-root', 'dist/demucs-runtime-assets'))
const releaseTag = getArgValue('--release-tag', 'demucs-runtime-assets')
const assetVersion = getArgValue('--asset-version', '')
const profilesArg = parseCsv(getArgValue('--profiles', ''))
const packagePrefix = getArgValue('--package-prefix', 'frkb-demucs-runtime')

const repoUrl = String(packageJson?.repository?.url || '')
const repoMatch = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i)
const githubOwner = getArgValue('--github-owner', repoMatch?.[1] || 'coderDjing')
const githubRepo = getArgValue(
  '--github-repo',
  repoMatch?.[2] || 'FRKB_Rapid-Audio-Organization-Tool'
)

const platformConfig = runtimeProfiles?.[platformKey]
if (!platformConfig || typeof platformConfig !== 'object') {
  console.error(`[demucs-runtime-package] Unsupported platform: ${platformKey}`)
  process.exit(1)
}

const profileNames = profilesArg.length > 0 ? profilesArg : Object.keys(platformConfig.profiles || {})
if (profileNames.length === 0) {
  console.error('[demucs-runtime-package] No profiles selected')
  process.exit(1)
}

const resolvedAssetVersion =
  assetVersion ||
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '')

const MAX_RELEASE_ASSET_SIZE = 2_000_000_000

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.status === 0) return
  throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
}

const computeFileSha256 = async (filePath) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const splitArchiveIfNeeded = async (archivePath) => {
  const archiveStat = fs.statSync(archivePath)
  if (archiveStat.size <= MAX_RELEASE_ASSET_SIZE) {
    return {
      archiveSize: archiveStat.size,
      archiveSha256: await computeFileSha256(archivePath),
      archiveParts: []
    }
  }

  const archiveDir = path.dirname(archivePath)
  const archiveBaseName = path.basename(archivePath)
  const fileHandle = await fs.promises.open(archivePath, 'r')
  const archiveParts = []
  let offset = 0
  let index = 0

  try {
    while (offset < archiveStat.size) {
      const chunkSize = Math.min(MAX_RELEASE_ASSET_SIZE, archiveStat.size - offset)
      const chunkBuffer = Buffer.allocUnsafe(chunkSize)
      await fileHandle.read(chunkBuffer, 0, chunkSize, offset)
      const partName = `${archiveBaseName}.part${String(index + 1).padStart(3, '0')}`
      const partPath = path.join(archiveDir, partName)
      fs.writeFileSync(partPath, chunkBuffer)
      archiveParts.push({
        index: index + 1,
        archiveName: partName,
        archiveSize: chunkSize,
        archiveSha256: await computeFileSha256(partPath)
      })
      offset += chunkSize
      index += 1
    }
  } finally {
    await fileHandle.close()
  }

  const archiveSha256 = await computeFileSha256(archivePath)
  fs.rmSync(archivePath, { force: true })
  return {
    archiveSize: archiveStat.size,
    archiveSha256,
    archiveParts
  }
}

const readRuntimeMeta = (runtimeDir) => {
  const metaPath = path.join(runtimeDir, '.frkb-runtime-meta.json')
  if (!fs.existsSync(metaPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return {}
  }
}

const resolveRuntimePythonRelativePath = (runtimeDir) => {
  const candidates = platformKey.startsWith('win32')
    ? ['python.exe', 'Scripts/python.exe']
    : ['bin/python3', 'bin/python']
  for (const relativePath of candidates) {
    const absolutePath = path.join(runtimeDir, ...relativePath.split('/'))
    if (!fs.existsSync(absolutePath)) continue
    return relativePath
  }
  throw new Error(`[demucs-runtime-package] Python entry missing in runtime: ${runtimeDir}`)
}

const createArchive = (params) => {
  const archivePath = params.archivePath
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { force: true })
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  if (process.platform === 'win32') {
    run('tar.exe', ['-a', '-cf', archivePath, '-C', params.platformRoot, params.runtimeKey])
    return
  }
  if (process.platform === 'darwin') {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', params.runtimeKey, archivePath], {
      cwd: params.platformRoot
    })
    return
  }
  run('zip', ['-qr', archivePath, params.runtimeKey], {
    cwd: params.platformRoot
  })
}

const assets = []
const platformRoot = path.join(runtimeRoot, platformKey)

for (const profileName of profileNames) {
  const profile = platformConfig.profiles?.[profileName]
  if (!profile) continue
  const runtimeKey = String(profile.targetDir || `runtime-${profileName}`)
  const runtimeDir = path.join(platformRoot, runtimeKey)
  if (!fs.existsSync(runtimeDir)) {
    console.warn(`[demucs-runtime-package] Skip missing runtime: ${runtimeDir}`)
    continue
  }
  const archiveName = `${packagePrefix}-${platformKey}-${profileName}-${resolvedAssetVersion}.zip`
  const archivePath = path.join(outputRoot, archiveName)
  createArchive({
    platformRoot,
    runtimeKey,
    archivePath
  })
  const archiveOutput = await splitArchiveIfNeeded(archivePath)
  const runtimeMeta = readRuntimeMeta(runtimeDir)
  const pythonRelativePath = resolveRuntimePythonRelativePath(runtimeDir)
  assets.push({
    platform: platformKey,
    profile: profileName,
    runtimeKey,
    version: resolvedAssetVersion,
    archiveName,
    archiveUrl:
      archiveOutput.archiveParts.length > 0
        ? ''
        : `https://github.com/${githubOwner}/${githubRepo}/releases/download/${releaseTag}/${archiveName}`,
    archiveSha256: archiveOutput.archiveSha256,
    archiveSize: archiveOutput.archiveSize,
    archiveParts: archiveOutput.archiveParts.map((item) => ({
      index: item.index,
      archiveName: item.archiveName,
      archiveUrl: `https://github.com/${githubOwner}/${githubRepo}/releases/download/${releaseTag}/${item.archiveName}`,
      archiveSha256: item.archiveSha256,
      archiveSize: item.archiveSize
    })),
    pythonRelativePath,
    generatedAt: new Date().toISOString(),
    torchVersion: String(runtimeMeta?.torchVersion || runtimeMeta?.probe?.torch_version || '')
  })
  console.log(
    `[demucs-runtime-package] Packed ${profileName} -> ${archiveName} (${Math.round(
      archiveOutput.archiveSize / 1024 / 1024
    )} MB${archiveOutput.archiveParts.length > 0 ? `, split=${archiveOutput.archiveParts.length}` : ''})`
  )
}

if (assets.length === 0) {
  console.error('[demucs-runtime-package] No runtime assets were packaged')
  process.exit(1)
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseTag,
  assets
}

fs.mkdirSync(outputRoot, { recursive: true })
fs.writeFileSync(
  path.join(outputRoot, 'demucs-runtime-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
)

console.log('[demucs-runtime-package] Manifest written:', path.join(outputRoot, 'demucs-runtime-manifest.json'))
