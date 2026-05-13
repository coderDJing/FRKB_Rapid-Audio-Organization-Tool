/**
 * 在加载原生模块之前设置 FFmpeg DLL 搜索路径（仅 Windows）
 * 必须在任何 rust_package 导入之前执行
 *
 * Windows 的 LoadLibrary 搜索顺序包含 PATH 环境变量，
 * 所以把 DLL 目录加到 PATH 即可让 .node 找到 FFmpeg DLL。
 */

if (process.platform === 'win32') {
  const path = require('path') as typeof import('path')
  const fs = require('fs') as typeof import('fs')

  function findFfmpegDllDir(): string | null {
    // 1. 环境变量
    const envDir = process.env.FRKB_FFMPEG_DLL_DIR
    if (envDir && fs.existsSync(envDir)) return envDir

    // 2. 打包后的 resources/ffmpeg-dlls/ 目录
    const exeDir = path.dirname(process.execPath)
    const resourcesDllDir = path.join(exeDir, 'resources', 'ffmpeg-dlls')
    if (fs.existsSync(resourcesDllDir)) return resourcesDllDir

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

  const dllDir = findFfmpegDllDir()
  if (dllDir) {
    // 将 DLL 目录添加到 PATH 最前面，LoadLibrary 会搜索 PATH
    process.env.PATH = dllDir + path.delimiter + (process.env.PATH || '')
  }
}
