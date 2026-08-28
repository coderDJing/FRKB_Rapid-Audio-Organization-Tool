const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const run = (file, args) => execFileAsync(file, args, { maxBuffer: 1024 * 1024 * 8 })

const otoolDependencies = async (filePath) => {
  const { stdout } = await run('otool', ['-L', filePath])
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (compatibility')[0])
    .filter(Boolean)
}

const collectMacNativeDependencies = async (context, appPath) => {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources')
  const frameworkPath = path.join(appPath, 'Contents', 'Frameworks')
  const rustPath = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'rust_package'
  )
  if (!fs.existsSync(rustPath)) return
  fs.mkdirSync(frameworkPath, { recursive: true })

  const nativeFiles = fs
    .readdirSync(rustPath)
    .filter((name) => name.endsWith('.node'))
    .map((name) => path.join(rustPath, name))
  const pending = [...nativeFiles]
  const visited = new Set()
  const bundled = new Map()
  const projectDir = context.packager.projectDir

  while (pending.length) {
    const current = pending.shift()
    if (!current || visited.has(current) || !fs.existsSync(current)) continue
    visited.add(current)
    for (const dependency of await otoolDependencies(current)) {
      if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/')) continue
      if (dependency.startsWith('@')) continue
      const basename = path.basename(dependency)
      let source = dependency
      if (!fs.existsSync(source)) {
        const candidates = [
          path.join(projectDir, 'rust_package', 'target', 'release', 'deps', basename),
          path.join(projectDir, 'rust_package', 'target', 'debug', 'deps', basename)
        ]
        source = candidates.find((candidate) => fs.existsSync(candidate)) || ''
      }
      if (!source) {
        throw new Error(`macOS native module dependency is missing: ${dependency}`)
      }
      const destination = path.join(frameworkPath, basename)
      if (!bundled.has(basename)) {
        fs.copyFileSync(source, destination)
        bundled.set(basename, destination)
        pending.push(destination)
      }
      await run('install_name_tool', ['-change', dependency, `@rpath/${basename}`, current])
    }
    if (path.extname(current) === '.dylib') {
      await run('install_name_tool', ['-id', `@rpath/${path.basename(current)}`, current])
    }
  }

  const nativeRpath = '@loader_path/../../../../Frameworks'
  for (const nativeFile of nativeFiles) {
    await run('install_name_tool', ['-add_rpath', nativeRpath, nativeFile]).catch(() => {})
  }
  for (const dylib of bundled.values()) {
    await run('install_name_tool', ['-add_rpath', '@loader_path', dylib]).catch(() => {})
  }
}

module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appFilename = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appFilename)

  await collectMacNativeDependencies(context, appPath)
  const rustPackagePath = path.join(
    appPath,
    'Contents/Resources/app.asar.unpacked/node_modules/rust_package'
  )
  const nativeEntry = fs
    .readdirSync(rustPackagePath)
    .filter((name) => name.startsWith('index.darwin-') && name.endsWith('.node'))
    .map((name) => path.join(rustPackagePath, name))[0]
  if (nativeEntry) await run('node', ['-e', `require(${JSON.stringify(nativeEntry)})`])
  await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appPath])
}
