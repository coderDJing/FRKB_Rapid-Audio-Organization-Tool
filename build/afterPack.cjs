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

    // 仅在 x64 构建中移除通用 ffmpeg，确保该文件只出现在一个架构内
    if (isX64) {
      await fs.remove(ffmpegUniversalPath)
      console.log(`[afterPack] removed universal ffmpeg from x64 build: ${ffmpegUniversalPath}`)
    } else {
      console.log(`[afterPack] keep universal ffmpeg in arm64 build: ${ffmpegUniversalPath}`)
    }
  } catch (err) {
    console.error('[afterPack] error while handling ffmpeg:', err)
    throw err
  }
}


