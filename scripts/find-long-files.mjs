#!/usr/bin/env node
/**
 * 扫描项目中行数超过阈值的文本代码文件
 * 默认：阈值 1000 行；后缀 .ts,.tsx,.js,.jsx,.vue,.css,.scss,.json,.md
 * 默认排除目录：node_modules, dist, out, .git
 *
 * 用法示例：
 *   node scripts/find-long-files.mjs --gt 1000 --ext .ts,.tsx,.js,.jsx,.vue --root . --exclude node_modules,dist,out,.git
 */

import fs from 'node:fs'
import path from 'node:path'

/** 将逗号分隔的参数解析为去重后的数组 */
function parseList(value, defaults) {
  if (!value || String(value).trim() === '') return [...new Set(defaults)]
  return [
    ...new Set(
      String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ]
}

/** 简单解析命令行参数 */
function parseArgs(argv) {
  const args = {
    root: '.',
    gt: 1100,
    ext: ['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.scss', '.json', '.md'],
    exclude: ['node_modules', 'dist', 'out', '.git', '.vitepress'],
    json: false
  }
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--root') args.root = argv[++i] ?? args.root
    else if (token === '--gt') args.gt = Number(argv[++i] ?? args.gt) || args.gt
    else if (token === '--ext') args.ext = parseList(argv[++i], args.ext)
    else if (token === '--exclude') args.exclude = parseList(argv[++i], args.exclude)
    else if (token === '--json') args.json = true
  }
  // 统一小写扩展名
  args.ext = args.ext.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
  return args
}

/** 判断路径是否应被排除（任一路径段命中排除名单即排除） */
function isExcludedDir(absPath, excludeNames) {
  const segments = absPath.split(path.sep)
  return segments.some((seg) => excludeNames.includes(seg))
}

/** 以流式读取方式统计文件行数（按 \n 计数，最后一行无换行符时补 1） */
function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let lineCount = 0
    let hasData = false
    let lastByte = 10 // 预设为 \n，空文件不会 +1
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      hasData = true
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) lineCount++ // \n
      }
      lastByte = chunk[chunk.length - 1]
    })
    stream.on('end', () => {
      if (hasData && lastByte !== 10) lineCount++ // 末尾非 \n，再补一行
      resolve(lineCount)
    })
    stream.on('error', reject)
  })
}

/** 深度遍历目录，筛选扩展名并统计行数 */
async function scanDirectory(rootDir, options) {
  const results = []
  async function walk(current) {
    // 排除目录早返回
    if (isExcludedDir(path.resolve(current), options.exclude)) return
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch (err) {
      // 权限或临时性错误，跳过
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!options.exclude.includes(entry.name)) {
          await walk(fullPath)
        }
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!options.ext.includes(ext)) continue
      if (isExcludedDir(path.resolve(fullPath), options.exclude)) continue
      try {
        const lines = await countLines(fullPath)
        if (lines > options.gt) {
          results.push({ lines, file: path.resolve(fullPath) })
        }
      } catch {
        // 读取失败的文件跳过
      }
    }
  }
  await walk(rootDir)
  return results.sort((a, b) => b.lines - a.lines)
}

async function main() {
  const args = parseArgs(process.argv)
  const root = path.resolve(args.root || '.')
  const results = await scanDirectory(root, args)
  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  if (results.length === 0) {
    console.log(`未找到超过 ${args.gt} 行的文件。`)
    return
  }
  const width = String(Math.max(...results.map((r) => r.lines))).length
  for (const r of results) {
    console.log(`${String(r.lines).padStart(width)}  ${path.relative(root, r.file)}`)
  }
}

main().catch((err) => {
  console.error('扫描出错：', err?.message || err)
  process.exit(1)
})
