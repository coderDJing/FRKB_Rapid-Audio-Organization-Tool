const path = require('path')
const fs = require('fs-extra')
const { Arch } = require('builder-util')

module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appFilename = `${context.packager.appInfo.productFilename}.app`
  const appBundleDir = path.join(context.appOutDir, appFilename)
  const ffmpegDir = path.join(appBundleDir, 'Contents', 'Resources', 'ffmpeg')

  const isX64Build = context.arch === Arch.x64
  const isArm64Build = context.arch === Arch.arm64

  if (!isX64Build && !isArm64Build) {
    return
  }

  const targetSubdir = isX64Build ? 'darwin-arm64' : 'darwin-x64'
  const removePath = path.join(ffmpegDir, targetSubdir)

  try {
    if (await fs.pathExists(removePath)) {
      await fs.remove(removePath)
      console.log(`afterPack: removed ${targetSubdir} for ${context.electronPlatformName} ${isX64Build ? 'x64' : 'arm64'} build`)
    } else {
      console.log(`afterPack: ${targetSubdir} not found, no removal needed`)
    }
  } catch (error) {
    console.error(`afterPack: failed to remove ${targetSubdir}:`, error)
    throw error
  }
}

