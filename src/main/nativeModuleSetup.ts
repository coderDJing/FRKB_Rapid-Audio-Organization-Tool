/**
 * 在加载原生模块之前设置原生媒体库搜索路径
 * 必须在任何 rust_package 导入之前执行
 *
 * Windows 的 LoadLibrary 搜索顺序包含 PATH 环境变量，
 * 所以把 DLL 目录加到 PATH 即可让 .node 找到 FFmpeg DLL。
 */

if (process.platform === 'win32' || process.platform === 'darwin') {
  const path = require('path') as typeof import('path')
  const fs = require('fs') as typeof import('fs')

  function configureR3StretchRuntime(): string | null {
    const configuredLibrary = String(process.env.FRKB_R3_STRETCH_LIBRARY || '').trim()
    if (configuredLibrary && fs.existsSync(configuredLibrary)) {
      return path.dirname(configuredLibrary)
    }

    const platformDir = process.platform === 'darwin' ? 'darwin-universal' : 'win32-x64'
    const libraryName = process.platform === 'darwin' ? 'librubberband.3.dylib' : 'rubberband-2.dll'
    const candidates = [
      path.join(process.cwd(), 'vendor', 'r3-stretch', platformDir),
      path.join(path.dirname(process.execPath), 'resources', 'r3-stretch', platformDir)
    ]
    for (const directory of candidates) {
      const libraryPath = path.join(directory, libraryName)
      if (!fs.existsSync(libraryPath)) continue
      process.env.FRKB_R3_STRETCH_LIBRARY = libraryPath
      return directory
    }
    return null
  }

  function findFfmpegDllDir(): string | null {
    // 1. 环境变量
    const envDir = process.env.FRKB_FFMPEG_DLL_DIR
    if (envDir && fs.existsSync(envDir)) return envDir

    // 2. 打包后的 FFmpeg DLL 目录
    const exeDir = path.dirname(process.execPath)
    const packagedPaths = [
      path.join(exeDir, 'resources', 'ffmpeg', 'win32-x64', 'dll'),
      path.join(exeDir, 'resources', 'ffmpeg-dlls')
    ]
    for (const p of packagedPaths) {
      if (fs.existsSync(p)) return p
    }

    // 3. 开发模式：相对于项目根目录
    const devPaths = [
      path.join(process.cwd(), 'rust_package', 'native', 'ffmpeg', 'win32-x64', 'bin'),
      path.join(process.cwd(), 'native', 'ffmpeg', 'win32-x64', 'bin')
    ]
    for (const p of devPaths) {
      if (fs.existsSync(p)) return p
    }

    return null
  }

  const nativeDllDirs = [configureR3StretchRuntime(), findFfmpegDllDir()].filter(
    (directory): directory is string => Boolean(directory)
  )
  if (nativeDllDirs.length > 0) {
    // 将 DLL 目录添加到 PATH 最前面，LoadLibrary 会搜索 PATH
    process.env.PATH = [...nativeDllDirs, process.env.PATH || ''].join(path.delimiter)
  }
}
