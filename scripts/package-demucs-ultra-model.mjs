import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)

const getArgValue = (flag, fallback = '') => {
  const directPrefix = `${flag}=`
  const direct = args.find((arg) => arg.startsWith(directPrefix))
  if (direct) return direct.slice(directPrefix.length).trim()
  const index = args.findIndex((arg) => arg === flag)
  if (index >= 0) return String(args[index + 1] || '').trim()
  return fallback
}

const sourceDir = path.resolve(getArgValue('--source-dir'))
const outputDir = path.resolve(getArgValue('--output-dir', 'dist/demucs-model-assets'))
const releaseTag = getArgValue('--release-tag', 'demucs-model-assets')
const version = getArgValue('--version', 'v4')
const owner = getArgValue('--github-owner', 'coderDJing')
const repo = getArgValue('--github-repo', 'FRKB_Rapid-Audio-Organization-Tool')
const modelName = 'htdemucs_ft'
const archiveName = `frkb-demucs-${modelName}-${version}.zip`
const expectedFileNames = [
  `${modelName}.yaml`,
  'f7e0c4bc-ba3fe64a.th',
  'd12395a8-e57c48e6.th',
  '92cfc3b6-ef3bcb9c.th',
  '04573f0d-f3cf25b2.th'
]

const requireNonEmpty = (value, message) => {
  if (!String(value || '').trim()) throw new Error(message)
  return value
}

const sha256File = (filePath) => {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.status === 0) return
  throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
}

const createTempRoot = () => {
  const root = path.join(outputDir, `.tmp-${modelName}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

const main = () => {
  requireNonEmpty(getArgValue('--source-dir'), 'Missing --source-dir')
  if (!fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Model source directory not found: ${sourceDir}`)
  }
  requireNonEmpty(releaseTag, 'Missing --release-tag')
  requireNonEmpty(version, 'Missing --version')

  const yamlPath = path.join(sourceDir, `${modelName}.yaml`)
  const yaml = fs.readFileSync(yamlPath, 'utf8')
  for (const signature of ['f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d']) {
    if (!yaml.includes(signature)) throw new Error(`Model YAML is missing signature: ${signature}`)
  }

  const files = expectedFileNames.map((name) => {
    const filePath = path.join(sourceDir, name)
    const stat = fs.statSync(filePath, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size <= 0)
      throw new Error(`Required model file missing: ${filePath}`)
    return {
      path: name,
      sha256: sha256File(filePath),
      size: stat.size
    }
  })

  fs.mkdirSync(outputDir, { recursive: true })
  const archivePath = path.join(outputDir, archiveName)
  const tempRoot = createTempRoot()
  const archiveRoot = path.join(tempRoot, modelName)
  try {
    fs.mkdirSync(archiveRoot, { recursive: true })
    for (const file of files) {
      fs.copyFileSync(path.join(sourceDir, file.path), path.join(archiveRoot, file.path))
    }
    fs.rmSync(archivePath, { force: true })
    if (process.platform === 'win32') {
      run('tar.exe', ['-a', '-c', '-f', archivePath, modelName], { cwd: tempRoot })
    } else if (process.platform === 'darwin') {
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', modelName, archivePath], {
        cwd: tempRoot
      })
    } else {
      run('zip', ['-q', '-r', archivePath, modelName], { cwd: tempRoot })
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  const archiveStat = fs.statSync(archivePath)
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseTag,
    assets: [
      {
        model: modelName,
        profile: 'ultra',
        version,
        archiveName,
        archiveUrl: `https://github.com/${owner}/${repo}/releases/download/${releaseTag}/${archiveName}`,
        archiveSha256: sha256File(archivePath),
        archiveSize: archiveStat.size,
        files
      }
    ]
  }
  const manifestPath = path.join(outputDir, 'demucs-model-manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(
    JSON.stringify(
      {
        archivePath,
        archiveSize: archiveStat.size,
        archiveSha256: manifest.assets[0].archiveSha256,
        manifestPath
      },
      null,
      2
    )
  )
}

try {
  main()
} catch (error) {
  console.error(`[demucs-ultra-model-package] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
