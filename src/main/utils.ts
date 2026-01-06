import store from './store'
import { IDir, md5 } from '../types/globals'
import fs = require('fs-extra')
import path = require('path')
import os = require('os')
import {
  calculateAudioHashesWithProgress,
  calculateFileHashesWithProgress,
  ProcessProgress,
  decodeAudioFile
} from 'rust_package'
import { BrowserWindow, ipcMain } from 'electron'
import {
  ensureLibraryTreeBaseline,
  loadLibraryNodes,
  syncLibraryTreeFromDisk
} from './libraryTreeDb'
import { pruneOrphanedSongListCaches } from './services/cacheMaintenance'

interface SongsAnalyseResult {
  songsAnalyseResult: md5[]
  errorSongsAnalyseResult: md5[]
}

// ===== 核心库英文/中文名称映射与路径解析 =====
const CORE_EN_TO_CN: Record<string, string> = {
  FilterLibrary: '筛选库',
  CuratedLibrary: '精选库',
  RecycleBin: '回收站'
}
const CORE_KEYS = Object.keys(CORE_EN_TO_CN) as Array<
  'FilterLibrary' | 'CuratedLibrary' | 'RecycleBin'
>
// 运行期：英文名 -> 实际物理目录名（优先英文，若重命名失败则回退中文）
const coreEnToFsName: Record<string, string> = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  RecycleBin: 'RecycleBin'
}

export async function ensureEnglishCoreLibraries(dbRootDir: string): Promise<void> {
  const base = path.join(dbRootDir, 'library')
  await fs.ensureDir(base)
  for (const enName of CORE_KEYS) {
    const cnName = CORE_EN_TO_CN[enName]
    const enPath = path.join(base, enName)
    const cnPath = path.join(base, cnName)
    const enExists = await fs.pathExists(enPath)
    const cnExists = await fs.pathExists(cnPath)
    try {
      if (enExists) {
        coreEnToFsName[enName] = enName
      } else if (cnExists) {
        // 尝试将中文目录重命名为英文
        try {
          await fs.rename(cnPath, enPath)
          coreEnToFsName[enName] = enName
        } catch (_e) {
          // 重命名失败，回退使用中文目录名，后续重试
          coreEnToFsName[enName] = cnName
          // 确保目标英文目录占位以便后续创建（不强制）
          // 不创建，避免与中文并存造成歧义
        }
      } else {
        // 两者都不存在，创建英文目录
        await fs.ensureDir(enPath)
        coreEnToFsName[enName] = enName
      }
    } catch (_err) {
      // 任一异常时，保守回退到中文
      coreEnToFsName[enName] = cnExists ? cnName : enName
    }
  }
}

export function getCoreFsDirName(
  enName: 'FilterLibrary' | 'CuratedLibrary' | 'RecycleBin'
): string {
  return coreEnToFsName[enName] || enName
}

export function mapRendererPathToFsPath(rendererPath: string): string {
  // 将渲染层路径中的英文核心库名替换为实际物理目录名
  let p = rendererPath
  for (const enName of CORE_KEYS) {
    const fsName = getCoreFsDirName(enName)
    p = p.replace(new RegExp(`(^|/)${enName}(/|$)`), `$1${fsName}$2`)
  }
  return p
}

// 指纹比较与阈值逻辑已移除（当前仅使用音频内容哈希判重）

export async function getSongsAnalyseResult(
  songFilePaths: string[],
  processFunc: Function
): Promise<SongsAnalyseResult> {
  function progressCallback(err: Error | null, progress: ProcessProgress) {
    if (!err && progress) {
      processFunc(progress.processed)
    }
  }
  // 根据 fingerprintMode 决定调用哪种分析器（暂时仅 PCM，稍后加入整文件哈希）
  const mode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
  let results: any[]
  if (mode === 'file') {
    results = await calculateFileHashesWithProgress(songFilePaths, progressCallback)
  } else {
    results = await calculateAudioHashesWithProgress(songFilePaths, progressCallback)
  }
  const existingHashes = new Set(store.songFingerprintList)

  const songsAnalyseResult: md5[] = []
  const errorSongsAnalyseResult: md5[] = []

  for (let item of results) {
    const common: md5 = {
      sha256_Hash: item.sha256Hash,
      file_path: item.filePath,
      // 仅保留必要字段
      error: item.error
    }

    if (item.sha256Hash === 'error') {
      errorSongsAnalyseResult.push(common)
      continue
    }

    let likelyDuplicate = false

    // 1. SHA256 直接判重复
    if (store.songFingerprintList.includes(common.sha256_Hash)) {
      likelyDuplicate = true
    }

    // 指纹 hash 与相似度判定分支已移除

    // 重复标记字段已移除（仅保留布尔含义于外层流程）

    songsAnalyseResult.push(common)
  }

  return { songsAnalyseResult, errorSongsAnalyseResult }
}
//获取整个库的树结构
export async function getLibrary(options: { skipSync?: boolean } = {}) {
  const rootDir = store.databaseDir
  if (!rootDir) {
    return { uuid: 'library_root_missing', type: 'root', dirName: 'library', children: [] }
  }
  // 先确保核心库英文化（若失败则回退中文），同时建立英文->FS 名的映射
  await ensureEnglishCoreLibraries(rootDir)
  await ensureLibraryTreeBaseline(rootDir, {
    coreDirNames: {
      FilterLibrary: getCoreFsDirName('FilterLibrary'),
      CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
      RecycleBin: getCoreFsDirName('RecycleBin')
    }
  })
  if (!options.skipSync) {
    await syncLibraryTreeFromDisk(rootDir, {
      coreDirNames: {
        FilterLibrary: getCoreFsDirName('FilterLibrary'),
        CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
        RecycleBin: getCoreFsDirName('RecycleBin')
      },
      audioExtensions: store.settingConfig?.audioExt
    })
    await pruneOrphanedSongListCaches(rootDir)
  }

  const rows = loadLibraryNodes(rootDir) || []
  if (rows.length === 0) {
    return { uuid: 'library_root_missing', type: 'root', dirName: 'library', children: [] }
  }

  const fsToRenderer = new Map<string, string>([
    [getCoreFsDirName('FilterLibrary'), 'FilterLibrary'],
    [getCoreFsDirName('CuratedLibrary'), 'CuratedLibrary'],
    [getCoreFsDirName('RecycleBin'), 'RecycleBin']
  ])

  const nodeMap = new Map<string, IDir>()
  let rootNode: IDir | null = null

  for (const row of rows) {
    let dirName = row.dirName
    if (row.nodeType === 'library') {
      const mapped = fsToRenderer.get(dirName)
      if (mapped) dirName = mapped
    }
    const node: IDir = {
      uuid: row.uuid,
      type: row.nodeType,
      dirName
    }
    if (row.order !== null) node.order = row.order
    nodeMap.set(row.uuid, node)
  }

  for (const row of rows) {
    const node = nodeMap.get(row.uuid)
    if (!node) continue
    if (row.parentUuid) {
      const parent = nodeMap.get(row.parentUuid)
      if (parent) {
        if (!parent.children) parent.children = []
        parent.children.push(node)
      }
    } else if (!rootNode) {
      rootNode = node
    }
  }

  const resolvedRoot: IDir = rootNode ??
    nodeMap.values().next().value ?? {
      uuid: 'library_root_missing',
      type: 'root',
      dirName: 'library',
      children: []
    }

  const sortChildren = (node: IDir) => {
    if (!node.children || node.children.length === 0) return
    node.children.sort((a, b) => {
      if (a.order === undefined || b.order === undefined) return 0
      return a.order - b.order
    })
    node.children.forEach(sortChildren)
  }

  if (!resolvedRoot.children) resolvedRoot.children = []
  sortChildren(resolvedRoot)
  return resolvedRoot
}

export const operateHiddenFile = async (
  filePath: string,
  operateFunction: () => Promise<any> | any
) => {
  // 统一 await，无论传入同步/异步
  const run = async () => await Promise.resolve(operateFunction())

  if (os.platform() !== 'win32') {
    // 非 Windows：直接运行
    return run()
  }

  const { exec } = require('child_process')
  const { promisify } = require('util')
  const execAsync = promisify(exec)

  // 独立处理 attrib 错误，避免覆盖业务异常
  const tryExec = async (cmd: string) => {
    try {
      await execAsync(cmd)
    } catch {
      // 静默忽略 attrib 失败（可能：文件不存在、被移动、权限受限）
    }
  }

  // 若存在则去隐藏，再执行业务，最后若存在则设隐藏
  const existedBefore = await fs.pathExists(filePath)
  if (existedBefore) {
    await tryExec(`attrib -h "${filePath}"`)
  }
  try {
    await run()
  } finally {
    const existsAfter = await fs.pathExists(filePath)
    if (existsAfter) {
      await tryExec(`attrib +h "${filePath}"`)
    }
  }
}

export const collectFilesWithExtensions = async (dir: string, extensions: string[] = []) => {
  let files: string[] = []
  try {
    const stats = await fs.stat(dir)

    if (stats.isFile()) {
      const ext = path.extname(dir).toLowerCase()
      if (extensions.includes(ext)) {
        return [dir]
      } else {
        return []
      }
    }

    // 读取目录中的文件和子目录
    const directoryEntries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of directoryEntries) {
      const fullPath = path.join(dir, entry.name)

      // 如果是文件，检查扩展名
      if (entry.isFile()) {
        const ext = path.extname(fullPath).toLowerCase()
        if (extensions.includes(ext)) {
          files.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        // 如果是目录，递归调用
        const subFiles = await collectFilesWithExtensions(fullPath, extensions)
        files = files.concat(subFiles)
      }
    }

    return files
  } catch (error) {
    return []
  }
}

export async function moveOrCopyItemWithCheckIsExist(
  src: string,
  targetPath: string,
  isMove: boolean
) {
  let isExist = await fs.pathExists(targetPath)
  if (isExist) {
    let counter = 1
    let baseName = path.basename(targetPath, path.extname(targetPath))
    let extension = path.extname(targetPath)
    let directory = path.dirname(targetPath)
    let newFileName = `${baseName} (${counter})${extension}`
    while (await fs.pathExists(path.join(directory, newFileName))) {
      counter++
      newFileName = `${baseName}(${counter})${extension}`
    }
    if (isMove) {
      await fs.move(src, path.join(directory, newFileName))
    } else {
      await fs.copy(src, path.join(directory, newFileName))
    }
    return path.join(directory, newFileName)
  } else {
    if (isMove) {
      await fs.move(src, targetPath)
    } else {
      await fs.copy(src, targetPath)
    }
    return targetPath
  }
}

export function isENOSPCError(error: any): boolean {
  try {
    const code = (error && (error as any).code) || ''
    const message = (error && (error as any).message) || ''
    return (
      String(code).toUpperCase() === 'ENOSPC' || /no space left on device/i.test(String(message))
    )
  } catch (_e) {
    return false
  }
}

type InterruptedDecision = 'resume' | 'cancel'

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  options: {
    concurrency?: number
    onProgress?: (done: number, total: number) => void
    onInterrupted?: (payload: {
      total: number
      done: number
      running: number
      pending: number
      successSoFar: number
      failedSoFar: number
    }) => Promise<InterruptedDecision>
    stopOnENOSPC?: boolean
  } = {}
): Promise<{
  results: Array<T | Error>
  success: number
  failed: number
  hasENOSPC: boolean
  skipped: number
}> {
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 16))
  const total = tasks.length
  const results: Array<T | Error> = new Array(total)
  let nextIndex = 0
  let inFlight = 0
  let completed = 0
  let hasENOSPC = false
  let interrupted = false
  let cancelled = false
  let skipped = 0

  const retryQueue: number[] = []

  // gate 用于在中断时阻塞调度；resume/cancel 后放行
  let gateResolve: (() => void) | null = null
  let gate: Promise<void> | null = null
  const closeGate = () => {
    if (gateResolve) gateResolve()
    gateResolve = null
    gate = null
  }
  const openGate = () => {
    if (!gate) {
      gate = new Promise<void>((resolve) => {
        gateResolve = resolve
      })
    }
  }

  const getNextTaskIndex = async (): Promise<number | null> => {
    // 若取消，停止调度
    if (cancelled) return null
    // 中断时阻塞，直到 resume/cancel
    if (interrupted && gate) {
      await gate
      if (cancelled) return null
    }
    if (retryQueue.length > 0) {
      return retryQueue.shift() as number
    }
    if (nextIndex < total) {
      const idx = nextIndex
      nextIndex++
      return idx
    }
    return null
  }

  async function handleENOSPC(idx: number, err: any) {
    hasENOSPC = true
    // 记录待重试
    retryQueue.push(idx)
    if (options.stopOnENOSPC !== false) {
      // 首次进入中断
      if (!interrupted) {
        interrupted = true
        openGate()
        if (typeof options.onInterrupted === 'function') {
          const successSoFar = results.filter(
            (r) => r !== undefined && !(r instanceof Error)
          ).length
          const failedSoFar = results.filter((r) => r instanceof Error).length
          const decision = await options.onInterrupted({
            total,
            done: completed,
            running: inFlight,
            pending: total - completed - inFlight,
            successSoFar,
            failedSoFar
          })
          if (decision === 'resume') {
            interrupted = false
            closeGate()
          } else {
            cancelled = true
            // 统计剩余未开始的任务为 skipped（包括重试队列 + 未派发）
            const remaining = total - completed - inFlight
            skipped += remaining
            closeGate()
          }
        }
      }
    }
  }

  async function worker() {
    while (true) {
      const idx = await getNextTaskIndex()
      if (idx === null) break
      inFlight++
      try {
        const val = await tasks[idx]()
        // 成功：若无返回值也要标记成功，避免统计为 0
        results[idx] = val === undefined ? (true as any) : val
        completed++
        if (options.onProgress) options.onProgress(completed, total)
      } catch (err: any) {
        if (isENOSPCError(err)) {
          await handleENOSPC(idx, err)
          // ENOSPC 情况下不计入完成，等待重试或取消
          if (cancelled) {
            // 取消时，本次失败计入失败
            results[idx] = err instanceof Error ? err : new Error(String(err))
            completed++
            if (options.onProgress) options.onProgress(completed, total)
          }
        } else {
          // 非 ENOSPC 失败，立即记入结果
          results[idx] = err instanceof Error ? err : new Error(String(err))
          completed++
          if (options.onProgress) options.onProgress(completed, total)
        }
      } finally {
        inFlight--
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
  await Promise.all(workers)

  const failed = results.filter((r) => r instanceof Error).length
  const success = results.filter((r) => r !== undefined && !(r instanceof Error)).length
  return { results, success, failed, hasENOSPC, skipped }
}

// ===== 用户交互：等待渲染层对中断批处理的决策（resume / cancel） =====
const fileOpControllers = new Map<string, (decision: InterruptedDecision) => void>()
let fileOpIpcRegistered = false

export function waitForUserDecision(
  win: BrowserWindow | null,
  batchId: string,
  context: string,
  payload: { total: number; done: number; running: number; pending: number }
): Promise<InterruptedDecision> {
  if (!fileOpIpcRegistered) {
    ipcMain.on('file-op-control', (_e, data: { batchId: string; action: InterruptedDecision }) => {
      const resolve = fileOpControllers.get(data?.batchId)
      if (resolve) {
        resolve(data.action)
        fileOpControllers.delete(data.batchId)
      }
    })
    fileOpIpcRegistered = true
  }
  return new Promise<InterruptedDecision>((resolve) => {
    fileOpControllers.set(batchId, resolve)
    win?.webContents.send('file-op-interrupted', { batchId, context, ...payload })
  })
}

export function getCurrentTimeYYYYMMDDHHMMSSSSS() {
  let now = new Date()

  let year = now.getFullYear()
  let month = now.getMonth() + 1 // 月份是从0开始的
  let day = now.getDate()
  let hour = now.getHours()
  let minute = now.getMinutes()
  let second = now.getSeconds()
  let millisecond = now.getMilliseconds()

  // 格式化月份、‌日期、‌小时、‌分钟、‌秒和毫秒
  let monthStr = month < 10 ? '0' + month : month
  let dayStr = day < 10 ? '0' + day : day
  let hourStr = hour < 10 ? '0' + hour : hour
  let minuteStr = minute < 10 ? '0' + minute : minute
  let secondStr = second < 10 ? '0' + second : second
  let millisecondStr =
    millisecond < 100 ? (millisecond < 10 ? '00' + millisecond : '0' + millisecond) : millisecond

  return (
    year +
    '' +
    monthStr +
    '' +
    dayStr +
    '' +
    hourStr +
    '' +
    minuteStr +
    '' +
    secondStr +
    '' +
    millisecondStr
  )
}
