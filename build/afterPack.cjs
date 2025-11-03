const path = require('path')
const fs = require('fs-extra')
const { Arch } = require('builder-util')

module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appFilename = `${context.packager.appInfo.productFilename}.app`
  const appBundleDir = path.join(context.appOutDir, appFilename)
  const ffmpegUniversalPath = path.join(appBundleDir, 'Contents', 'Resources', 'ffmpeg', 'darwin', 'ffmpeg')

  const isX64 = context.arch === Arch.x64
  const isArm64 = context.arch === Arch.arm64

  console.log(`[afterPack] platform=darwin arch=${isX64 ? 'x64' : isArm64 ? 'arm64' : String(context.arch)} appDir=${context.appOutDir}`)
  try {
    const exists = await fs.pathExists(ffmpegUniversalPath)
    console.log(`[afterPack] exists(${ffmpegUniversalPath}) = ${exists}`)
    if (!exists) return

    // 不再删除，保证两个架构的包在相同路径存在相同文件，配合 singleArchFiles 合并
    console.log(`[afterPack] keep universal ffmpeg in ${isX64 ? 'x64' : isArm64 ? 'arm64' : String(context.arch)} build: ${ffmpegUniversalPath}`)
  } catch (err) {
    console.error('[afterPack] error while handling ffmpeg:', err)
    throw err
  }
}


