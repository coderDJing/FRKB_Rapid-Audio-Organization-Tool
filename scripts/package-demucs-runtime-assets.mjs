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

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true
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

const readRuntimeMeta = (runtimeDir) => {
  const metaPath = path.join(runtimeDir, '.frkb-runtime-meta.json')
  if (!fs.existsSync(metaPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return {}
  }
}

const createArchive = (params) => {
  const archivePath = params.archivePath
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { force: true })
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  run('tar.exe', ['-a', '-cf', archivePath, '-C', params.platformRoot, params.runtimeKey])
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
  const archiveStat = fs.statSync(archivePath)
  const archiveSha256 = await computeFileSha256(archivePath)
  const runtimeMeta = readRuntimeMeta(runtimeDir)
  assets.push({
    platform: platformKey,
    profile: profileName,
    runtimeKey,
    version: resolvedAssetVersion,
    archiveName,
    archiveUrl: `https://github.com/${githubOwner}/${githubRepo}/releases/download/${releaseTag}/${archiveName}`,
    archiveSha256,
    archiveSize: archiveStat.size,
    pythonRelativePath: platformKey.startsWith('win32') ? 'python.exe' : 'bin/python3',
    generatedAt: new Date().toISOString(),
    torchVersion: String(runtimeMeta?.torchVersion || runtimeMeta?.probe?.torch_version || '')
  })
  console.log(
    `[demucs-runtime-package] Packed ${profileName} -> ${archiveName} (${Math.round(
      archiveStat.size / 1024 / 1024
    )} MB)`
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
