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

if (inputRoots.length === 0) {
  console.error('[demucs-runtime-merge] No input roots provided')
  process.exit(1)
}

const manifests = []
for (const rawRoot of inputRoots) {
  const root = path.resolve(rawRoot)
  const manifestPath = path.join(root, 'demucs-runtime-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.error(`[demucs-runtime-merge] Missing manifest: ${manifestPath}`)
    process.exit(1)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifests.push({
    root,
    manifest
  })
}

const mergedAssets = []
const seenKeys = new Set()

fs.mkdirSync(outputRoot, { recursive: true })

for (const { root, manifest } of manifests) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : []
  for (const asset of assets) {
    const assetKey = [asset?.platform, asset?.profile, asset?.runtimeKey, asset?.version].join(':')
    if (seenKeys.has(assetKey)) {
      console.error(`[demucs-runtime-merge] Duplicate asset key: ${assetKey}`)
      process.exit(1)
    }
    seenKeys.add(assetKey)

    const archiveName = String(asset?.archiveName || '').trim()
    if (!archiveName) {
      console.error(`[demucs-runtime-merge] Asset archiveName missing: ${assetKey}`)
      process.exit(1)
    }
    const archiveParts = Array.isArray(asset?.archiveParts) ? asset.archiveParts : []
    if (archiveParts.length > 0) {
      for (const part of archiveParts) {
        const partName = String(part?.archiveName || '').trim()
        if (!partName) {
          console.error(`[demucs-runtime-merge] Missing archive part name: ${assetKey}`)
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
    mergedAssets.push(asset)
  }
}

const mergedManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseTag,
  assets: mergedAssets
}

const outputManifestPath = path.join(outputRoot, 'demucs-runtime-manifest.json')
fs.writeFileSync(outputManifestPath, `${JSON.stringify(mergedManifest, null, 2)}\n`, 'utf8')

console.log(
  `[demucs-runtime-merge] merged ${mergedAssets.length} assets -> ${outputManifestPath}`
)
