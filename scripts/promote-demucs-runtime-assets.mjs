import fs from 'node:fs'
import path from 'node:path'

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

const normalizeText = (value) => String(value || '').trim()
const toBaseVersion = (value) => normalizeText(value).replace(/-.+$/, '')
const inferChannelFromReleaseTag = (tag) =>
  /(^|[-_])(rc|beta|alpha)([-_.]|$)/i.test(normalizeText(tag)) ? 'rc' : 'stable'

const sourceRoot = path.resolve(getArgValue('--source-root', ''))
const outputRoot = path.resolve(getArgValue('--output-root', 'dist/demucs-runtime-assets'))
const sourceReleaseTag = normalizeText(getArgValue('--source-release-tag', 'demucs-runtime-assets-rc'))
const targetReleaseTag = normalizeText(getArgValue('--target-release-tag', 'demucs-runtime-assets'))
const appVersion = normalizeText(getArgValue('--app-version', ''))

if (!sourceRoot) {
  console.error('[demucs-runtime-promote] Missing --source-root')
  process.exit(1)
}

if (!appVersion) {
  console.error('[demucs-runtime-promote] Missing --app-version')
  process.exit(1)
}

if (/-/.test(appVersion)) {
  console.error(`[demucs-runtime-promote] --app-version must be stable: ${appVersion}`)
  process.exit(1)
}

const sourceManifestPath = path.join(sourceRoot, 'demucs-runtime-manifest.json')
if (!fs.existsSync(sourceManifestPath)) {
  console.error(`[demucs-runtime-promote] Missing source manifest: ${sourceManifestPath}`)
  process.exit(1)
}

const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
const sourceAssets = Array.isArray(sourceManifest?.assets) ? sourceManifest.assets : []
if (sourceAssets.length === 0) {
  console.error('[demucs-runtime-promote] Source manifest has no assets')
  process.exit(1)
}

const sourceChannel =
  normalizeText(sourceManifest?.channel).toLowerCase() || inferChannelFromReleaseTag(sourceReleaseTag)
if (sourceChannel !== 'rc') {
  console.error(
    `[demucs-runtime-promote] Source manifest is not RC channel: ${sourceChannel || '<empty>'}`
  )
  process.exit(1)
}

const buildReleaseAssetUrl = (releaseTag, archiveName) =>
  `https://github.com/coderDjing/FRKB_Rapid-Audio-Organization-Tool/releases/download/${releaseTag}/${archiveName}`

const copyFileChecked = (sourcePath, targetPath) => {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`missing asset: ${sourcePath}`)
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.copyFileSync(sourcePath, targetPath)
}

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(outputRoot, { recursive: true })

const promotedAssets = sourceAssets.map((asset) => {
  const archiveName = normalizeText(asset?.archiveName)
  if (!archiveName) {
    throw new Error('[demucs-runtime-promote] Asset archiveName missing')
  }

  const archiveParts = Array.isArray(asset?.archiveParts) ? asset.archiveParts : []
  if (archiveParts.length > 0) {
    const promotedParts = archiveParts.map((part) => {
      const partName = normalizeText(part?.archiveName)
      if (!partName) {
        throw new Error(`[demucs-runtime-promote] Asset archive part missing: ${archiveName}`)
      }
      copyFileChecked(path.join(sourceRoot, partName), path.join(outputRoot, partName))
      return {
        ...part,
        archiveUrl: buildReleaseAssetUrl(targetReleaseTag, partName)
      }
    })
    return {
      ...asset,
      archiveUrl: '',
      archiveParts: promotedParts
    }
  }

  copyFileChecked(path.join(sourceRoot, archiveName), path.join(outputRoot, archiveName))
  return {
    ...asset,
    archiveUrl: buildReleaseAssetUrl(targetReleaseTag, archiveName),
    archiveParts: []
  }
})

const promotedManifest = {
  ...sourceManifest,
  generatedAt: new Date().toISOString(),
  releaseTag: targetReleaseTag,
  channel: 'stable',
  appVersion,
  appBaseVersion: toBaseVersion(appVersion),
  promotedFrom: {
    releaseTag: sourceReleaseTag,
    channel: sourceChannel,
    appVersion: normalizeText(sourceManifest?.appVersion),
    appBaseVersion: normalizeText(sourceManifest?.appBaseVersion),
    generatedAt: normalizeText(sourceManifest?.generatedAt)
  },
  assets: promotedAssets
}

const outputManifestPath = path.join(outputRoot, 'demucs-runtime-manifest.json')
fs.writeFileSync(outputManifestPath, `${JSON.stringify(promotedManifest, null, 2)}\n`, 'utf8')

console.log(
  `[demucs-runtime-promote] promoted ${promotedAssets.length} assets: ${sourceReleaseTag} -> ${targetReleaseTag}`
)
console.log(`[demucs-runtime-promote] manifest written: ${outputManifestPath}`)
