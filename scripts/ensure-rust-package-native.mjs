import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)

const readFlagValue = (flag) => {
  const index = args.indexOf(flag)
  if (index < 0) return ''
  return String(args[index + 1] || '').trim()
}

const mode = readFlagValue('--mode') || 'dev'
const isReleaseBuild = mode === 'package' || args.includes('--release')

const repoRoot = process.cwd()
const rustPackageDir = path.resolve(repoRoot, 'rust_package')
const cargoManifestPath = path.join(rustPackageDir, 'Cargo.toml')

const walkFiles = (dirPath) => {
  if (!fs.existsSync(dirPath)) return []

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      return walkFiles(entryPath)
    }
    return [entryPath]
  })
}

const getNewestMtimeMs = (filePaths) =>
  filePaths.reduce((latest, filePath) => {
    if (!fs.existsSync(filePath)) return latest
    const stats = fs.statSync(filePath)
    return Math.max(latest, stats.mtimeMs)
  }, 0)

const resolveBinaryConfig = () => {
  if (process.platform === 'win32') {
    if (process.arch === 'x64') {
      return {
        artifactFileName: 'rust_package.dll',
        suffix: 'win32-x64-msvc'
      }
    }
    if (process.arch === 'arm64') {
      return {
        artifactFileName: 'rust_package.dll',
        suffix: 'win32-arm64-msvc'
      }
    }
    if (process.arch === 'ia32') {
      return {
        artifactFileName: 'rust_package.dll',
        suffix: 'win32-ia32-msvc'
      }
    }
  }

  if (process.platform === 'darwin') {
    if (process.arch === 'x64') {
      return {
        artifactFileName: 'librust_package.dylib',
        suffix: 'darwin-x64'
      }
    }
    if (process.arch === 'arm64') {
      return {
        artifactFileName: 'librust_package.dylib',
        suffix: 'darwin-arm64'
      }
    }
  }

  return null
}

const binaryConfig = resolveBinaryConfig()
if (!binaryConfig) {
  console.warn(
    `[frkb-native] skip rust_package build on unsupported platform ${process.platform}-${process.arch}`
  )
  process.exit(0)
}

const profileDir = isReleaseBuild ? 'release' : 'debug'
const sourceInputs = [
  cargoManifestPath,
  path.join(rustPackageDir, 'build.rs'),
  ...walkFiles(path.join(rustPackageDir, 'src')),
  ...walkFiles(path.join(rustPackageDir, 'native'))
]
const newestSourceMtimeMs = getNewestMtimeMs(sourceInputs)
const targetBinaryPath = path.join(
  rustPackageDir,
  'target',
  profileDir,
  binaryConfig.artifactFileName
)
const builtBinaryPath = path.join(rustPackageDir, `rust_package.${binaryConfig.suffix}.node`)
const preferredBinaryPath = path.join(rustPackageDir, `index.${binaryConfig.suffix}.node`)

const hasFreshFile = (filePath) => {
  if (!fs.existsSync(filePath)) return false
  return fs.statSync(filePath).mtimeMs >= newestSourceMtimeMs
}

const isSyncedWithTarget = (filePath) => {
  if (!fs.existsSync(filePath) || !fs.existsSync(targetBinaryPath)) return false
  return fs.statSync(filePath).mtimeMs >= fs.statSync(targetBinaryPath).mtimeMs
}

const syncBinaryOutputs = () => {
  if (!fs.existsSync(targetBinaryPath)) {
    throw new Error(`未找到 Rust 编译产物: ${targetBinaryPath}`)
  }

  fs.copyFileSync(targetBinaryPath, builtBinaryPath)
  fs.copyFileSync(targetBinaryPath, preferredBinaryPath)
}

const needsBuild = !hasFreshFile(targetBinaryPath)

if (needsBuild) {
  const cargoArgs = ['build', '--manifest-path', cargoManifestPath]
  if (isReleaseBuild) {
    cargoArgs.push('--release')
  }

  console.log(
    `[frkb-native] building rust_package (${process.platform}-${process.arch}, profile=${profileDir})`
  )

  const buildResult = spawnSync('cargo', cargoArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: false
  })

  if ((buildResult.status ?? 1) !== 0) {
    process.exit(buildResult.status ?? 1)
  }
}

if (!isSyncedWithTarget(builtBinaryPath) || !isSyncedWithTarget(preferredBinaryPath)) {
  syncBinaryOutputs()
  console.log(`[frkb-native] synced ${path.basename(preferredBinaryPath)}`)
}
