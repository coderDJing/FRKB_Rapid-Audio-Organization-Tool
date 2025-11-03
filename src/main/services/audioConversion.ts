import { BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import child_process = require('child_process')
import store from '../store'
import FingerprintStore from '../fingerprintStore'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import { getCoreFsDirName, operateHiddenFile, runWithConcurrency } from '../utils'

type ConvertJobOptions = {
  src: string
  targetFormat: 'mp3' | 'flac' | 'wav' | 'aiff' | 'aif'
  bitrateKbps?: number
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  preserveMetadata?: boolean
  normalize?: boolean
  strategy: 'new_file' | 'replace'
  overwrite?: boolean
  backupOnReplace?: boolean
  addFingerprint?: boolean
}

type StartPayload = {
  files: string[]
  options: ConvertJobOptions
  songListUUID?: string
}

const jobIdToChildren = new Map<string, child_process.ChildProcess>()

function buildNonConflictTarget(src: string, fmt: string): string {
  const dir = path.dirname(src)
  const base = path.basename(src, path.extname(src))
  const suffix = ` [${fmt}]`
  let candidate = path.join(dir, `${base}${suffix}.${fmt}`)
  let idx = 1
  while (fs.pathExistsSync(candidate)) {
    candidate = path.join(dir, `${base}${suffix} (${idx}).${fmt}`)
    idx++
  }
  return candidate
}

async function backupOriginalIfNeeded(src: string) {
  const now = new Date()
  const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n)
  const dirName = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
    now.getDate()
  )}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`
  const recycleBinTargetDir = path.join(
    store.databaseDir,
    'library',
    getCoreFsDirName('RecycleBin'),
    dirName
  )
  await fs.ensureDir(recycleBinTargetDir)
  const dest = path.join(recycleBinTargetDir, path.basename(src))
  await fs.move(src, dest)
  const descriptionJson = { uuid: uuidV4(), type: 'songList' as const, order: Date.now() }
  await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
    if (!(await fs.pathExists(path.join(recycleBinTargetDir, '.description.json')))) {
      await fs.outputJSON(path.join(recycleBinTargetDir, '.description.json'), descriptionJson)
    }
  })
  return { dirName, descriptionJson }
}

function buildFfmpegArgs(src: string, dest: string, opts: ConvertJobOptions): string[] {
  const args: string[] = ['-y', '-i', src]
  if (opts.sampleRate) args.push('-ar', String(opts.sampleRate))
  if (opts.channels) args.push('-ac', String(opts.channels))
  if (opts.normalize) args.push('-filter:a', 'loudnorm')
  if (opts.preserveMetadata) args.push('-map_metadata', '0')
  // 编码器与比特率
  switch (opts.targetFormat) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'flac':
      args.push('-c:a', 'flac')
      break
    case 'wav':
      args.push('-c:a', 'pcm_s16le')
      break
    case 'aiff':
      // AIFF 常用大端 PCM；如需与特定设备兼容可改成 pcm_s16le
      args.push('-c:a', 'pcm_s16be')
      break
    case 'aif':
      args.push('-c:a', 'pcm_s16be')
      break
  }
  // 进度：简单采用 -hide_banner -nostats；百分比将按文件计数汇总，由 UI 侧显示
  args.push(dest)
  return args
}

export async function startAudioConversion(
  mainWindow: BrowserWindow | null,
  payload: StartPayload
): Promise<{ jobId: string }> {
  const jobId = `convert_${Date.now()}_${uuidV4()}`
  const { files, options, songListUUID } = payload
  const ffmpegPath = resolveBundledFfmpegPath()
  await ensureExecutableOnMac(ffmpegPath)

  const startedAt = Date.now()
  // 任务开始即推送一次全局进度，确保底部进度条立刻显示
  try {
    if (mainWindow) {
      mainWindow.webContents.send('progressSet', {
        id: jobId,
        titleKey: 'audio.convert',
        now: 0,
        total: files.length,
        isInitial: true
      })
    }
  } catch {}
  let success = 0
  let failed = 0
  let renamed = 0
  let overwritten = 0
  let backupCount = 0
  let fingerprintAddedCount = 0
  let skipped = 0

  const tasks: Array<() => Promise<void>> = files.map((src) => async () => {
    try {
      // 同格式跳过（aif/aiff 互认为同类）
      const ext = path.extname(src).toLowerCase()
      const tgt = options.targetFormat
      const isAifFamily = (e: string) => e === '.aif' || e === '.aiff'
      const sameFormat =
        (tgt === 'mp3' && ext === '.mp3') ||
        (tgt === 'flac' && ext === '.flac') ||
        (tgt === 'wav' && ext === '.wav') ||
        ((tgt === 'aif' || tgt === 'aiff') && isAifFamily(ext))
      if (sameFormat) {
        skipped += 1
        if (mainWindow) mainWindow.webContents.send('audio:convert:progress', { jobId })
        return
      }
      // 目标路径
      let dest = ''
      if (options.strategy === 'replace') {
        dest = path.join(
          path.dirname(src),
          `${path.basename(src, path.extname(src))}.${options.targetFormat}`
        )
        if (path.extname(src).toLowerCase() !== `.${options.targetFormat}`.toLowerCase()) {
          // 不同格式替换：输出临时文件，备份原文件后覆盖同名目标
          const tmp = path.join(
            path.dirname(src),
            `.${path.basename(src)}.tmp.${options.targetFormat}`
          )
          const args = buildFfmpegArgs(src, tmp, options)
          const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
          jobIdToChildren.set(jobId, child)
          await new Promise<void>((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))
            )
          })
          // 备份并覆盖
          const { descriptionJson } = await backupOriginalIfNeeded(src)
          backupCount += 1
          await fs.move(tmp, dest, { overwrite: true })
          overwritten += 1
        } else {
          // 同格式重新编码直接覆盖：备份原文件，再输出到原路径
          const tmp = path.join(
            path.dirname(src),
            `.${path.basename(src)}.tmp.${options.targetFormat}`
          )
          const args = buildFfmpegArgs(src, tmp, options)
          const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
          jobIdToChildren.set(jobId, child)
          await new Promise<void>((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))
            )
          })
          await backupOriginalIfNeeded(src)
          backupCount += 1
          await fs.move(tmp, src, { overwrite: true })
          overwritten += 1
          dest = src
        }
      } else {
        dest = buildNonConflictTarget(src, options.targetFormat)
        const tmp = path.join(
          path.dirname(dest),
          `.${path.basename(dest)}.tmp.${options.targetFormat}`
        )
        const args = buildFfmpegArgs(src, tmp, options)
        const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
        jobIdToChildren.set(jobId, child)
        await new Promise<void>((resolve, reject) => {
          child.on('error', reject)
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))
          )
        })
        await fs.move(tmp, dest, { overwrite: false })
        renamed += 1
      }

      // 指纹入库（可选）
      if (options.addFingerprint) {
        try {
          const { getSongsAnalyseResult } = require('../utils')
          const res = await getSongsAnalyseResult([dest], () => {})
          const list = (res?.songsAnalyseResult || []).map((x: any) => x.sha256_Hash)
          if (list.length > 0) {
            const beforeLen = store.songFingerprintList.length
            store.songFingerprintList = Array.from(new Set([...store.songFingerprintList, ...list]))
            if (store.songFingerprintList.length !== beforeLen) {
              await FingerprintStore.saveList(
                store.songFingerprintList,
                ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
              )
              fingerprintAddedCount += store.songFingerprintList.length - beforeLen
            }
          }
        } catch {}
      }

      success += 1
      if (mainWindow) mainWindow.webContents.send('audio:convert:progress', { jobId })
    } catch (e) {
      failed += 1
      if (mainWindow) mainWindow.webContents.send('audio:convert:progress', { jobId })
    }
  })

  await runWithConcurrency(tasks, {
    concurrency: 1,
    onProgress: (done, total) => {
      if (mainWindow)
        mainWindow.webContents.send('progressSet', {
          id: jobId,
          titleKey: 'audio.convert',
          now: done,
          total,
          isInitial: done === 0
        })
    }
  })

  if (mainWindow) {
    mainWindow.webContents.send('progressSet', {
      id: jobId,
      titleKey: 'audio.convert',
      now: files.length,
      total: files.length
    })
    mainWindow.webContents.send('audio:convert:done', {
      jobId,
      songListUUID,
      summary: {
        total: files.length,
        success,
        failed,
        skipped,
        overwritten,
        renamed,
        backupCount,
        fingerprintAddedCount,
        durationMs: Date.now() - startedAt
      },
      errors: []
    })
  }

  jobIdToChildren.delete(jobId)
  return { jobId }
}

export function cancelAudioConversion(jobId: string) {
  const child = jobIdToChildren.get(jobId)
  if (child) {
    try {
      // 优先尝试发送 'q' 结束
      child.stdin?.write('q')
    } catch {}
    try {
      child.kill()
    } catch {}
    jobIdToChildren.delete(jobId)
  }
}
