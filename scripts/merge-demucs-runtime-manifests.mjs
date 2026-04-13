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

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const inputRoots = parseCsv(getArgValue('--input-roots', ''))
const outputRoot = path.resolve(getArgValue('--output-root', 'dist/demucs-runtime-assets'))
const releaseTag = getArgValue('--release-tag', 'demucs-runtime-assets')
const baseManifestPath = getArgValue('--base-manifest', '').trim()
const appVersionArg = getArgValue('--app-version', '').trim()
const channelArg = getArgValue('--channel', '').trim().toLowerCase()

if (inputRoots.length === 0) {
  console.error('[demucs-runtime-merge] No input roots provided')
  process.exit(1)
}

const normalizeText = (value) => String(value || '').trim()
const toBaseVersion = (value) => normalizeText(value).replace(/-.+$/, '')
const inferChannelFromReleaseTag = (tag) =>
  /(^|[-_])(rc|beta|alpha)([-_.]|$)/i.test(normalizeText(tag)) ? 'rc' : 'stable'
const toAssetIdentityKey = (asset) =>
  [asset?.platform, asset?.profile, asset?.runtimeKey].map((item) => normalizeText(item)).join(':')

const readManifest = (manifestPath) => {
  const resolvedManifestPath = path.resolve(manifestPath)
  if (!fs.existsSync(resolvedManifestPath)) {
    console.error(`[demucs-runtime-merge] Missing manifest: ${resolvedManifestPath}`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'))
}

const manifests = []
for (const rawRoot of inputRoots) {
  const root = path.resolve(rawRoot)
  const manifestPath = path.join(root, 'demucs-runtime-manifest.json')
  const manifest = readManifest(manifestPath)
  manifests.push({
    root,
    manifest
  })
}

const mergedAssetsByKey = new Map()
const seenIncomingKeys = new Set()

fs.mkdirSync(outputRoot, { recursive: true })

if (baseManifestPath) {
  const baseManifest = readManifest(baseManifestPath)
  const baseAssets = Array.isArray(baseManifest?.assets) ? baseManifest.assets : []
  for (const asset of baseAssets) {
    const assetIdentityKey = toAssetIdentityKey(asset)
    if (!assetIdentityKey || assetIdentityKey === '::') continue
    mergedAssetsByKey.set(assetIdentityKey, asset)
  }
}

for (const { root, manifest } of manifests) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : []
  for (const asset of assets) {
    const assetIdentityKey = toAssetIdentityKey(asset)
    if (seenIncomingKeys.has(assetIdentityKey)) {
      console.error(`[demucs-runtime-merge] Duplicate asset identity: ${assetIdentityKey}`)
      process.exit(1)
    }
    seenIncomingKeys.add(assetIdentityKey)

    const archiveName = normalizeText(asset?.archiveName)
    if (!archiveName) {
      console.error(`[demucs-runtime-merge] Asset archiveName missing: ${assetIdentityKey}`)
      process.exit(1)
    }
    const archiveParts = Array.isArray(asset?.archiveParts) ? asset.archiveParts : []
    if (archiveParts.length > 0) {
      for (const part of archiveParts) {
        const partName = normalizeText(part?.archiveName)
        if (!partName) {
          console.error(`[demucs-runtime-merge] Missing archive part name: ${assetIdentityKey}`)
          process.exit(1)
        }
        const sourcePartPath = path.join(root, partName)
        const targetPartPath = path.join(outputRoot, partName)
        if (!fs.existsSync(sourcePartPath)) {
          console.error(`[demucs-runtime-merge] Missing archive part: ${sourcePartPath}`)
          process.exit(1)
        }
        fs.copyFileSync(sourcePartPath, targetPartPath)
      }
    } else {
      const sourceArchivePath = path.join(root, archiveName)
      const targetArchivePath = path.join(outputRoot, archiveName)
      if (!fs.existsSync(sourceArchivePath)) {
        console.error(`[demucs-runtime-merge] Missing archive: ${sourceArchivePath}`)
        process.exit(1)
      }
      fs.copyFileSync(sourceArchivePath, targetArchivePath)
    }
    mergedAssetsByKey.set(assetIdentityKey, asset)
  }
}

const mergedAssets = Array.from(mergedAssetsByKey.values()).sort((a, b) => {
  const left = [a?.platform, a?.profile, a?.runtimeKey].map((item) => normalizeText(item)).join(':')
  const right = [b?.platform, b?.profile, b?.runtimeKey]
    .map((item) => normalizeText(item))
    .join(':')
  return left.localeCompare(right)
})

const primaryManifest = manifests[0]?.manifest || {}
const appVersion = appVersionArg || normalizeText(primaryManifest.appVersion)
const appBaseVersion = appVersion ? toBaseVersion(appVersion) : normalizeText(primaryManifest.appBaseVersion)
const channel =
  channelArg === 'rc' || channelArg === 'stable'
    ? channelArg
    : normalizeText(primaryManifest.channel) || inferChannelFromReleaseTag(releaseTag)

const mergedManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseTag,
  channel,
  appVersion,
  appBaseVersion,
  assets: mergedAssets
}

const outputManifestPath = path.join(outputRoot, 'demucs-runtime-manifest.json')
fs.writeFileSync(outputManifestPath, `${JSON.stringify(mergedManifest, null, 2)}\n`, 'utf8')

console.log(`[demucs-runtime-merge] merged ${mergedAssets.length} assets -> ${outputManifestPath}`)
