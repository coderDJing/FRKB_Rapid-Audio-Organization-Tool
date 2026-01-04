import { BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import child_process = require('child_process')
import store from '../store'
import FingerprintStore from '../fingerprintStore'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import { getCoreFsDirName, runWithConcurrency } from '../utils'
import {
  SUPPORTED_AUDIO_FORMATS,
  ENCODER_REQUIREMENTS,
  type SupportedAudioFormat
} from '../../shared/audioFormats'
import { writeWavRiffInfoWindows } from './wavRiffInfo'
import { findLibraryNodeByPath, insertLibraryNode } from '../libraryTreeDb'

type ConvertJobOptions = {
  src: string
  targetFormat:
    | 'mp3'
    | 'flac'
    | 'wav'
    | 'aiff'
    | 'aif'
    | 'ogg'
    | 'opus'
    | 'aac'
    | 'm4a'
    | 'mp4'
    | 'wma'
    | 'ac3'
    | 'dts'
    | 'mka'
    | 'webm'
    | 'wv'
    | 'tta'
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
  const recycleNodePath = path.join('library', getCoreFsDirName('RecycleBin'), dirName)
  const existingNode = findLibraryNodeByPath(recycleNodePath)
  const descriptionJson = {
    uuid: existingNode?.uuid || uuidV4(),
    type: 'songList' as const,
    order: existingNode?.order ?? Date.now()
  }
  if (!existingNode) {
    const parentNode = findLibraryNodeByPath(path.join('library', getCoreFsDirName('RecycleBin')))
    if (parentNode) {
      insertLibraryNode({
        uuid: descriptionJson.uuid,
        parentUuid: parentNode.uuid,
        dirName,
        nodeType: 'songList',
        order: descriptionJson.order
      })
    }
  }
  return { dirName, descriptionJson }
}

function buildFfmpegArgs(src: string, dest: string, opts: ConvertJobOptions): string[] {
  const args: string[] = ['-y', '-i', src]
  let sampleRateApplied = false
  let channelsApplied = false
  const applySampleRate = (rate: number) => {
    args.push('-ar', String(rate))
    sampleRateApplied = true
  }
  const applyChannels = (count: number) => {
    args.push('-ac', String(count))
    channelsApplied = true
  }
  if (opts.normalize) args.push('-filter:a', 'loudnorm')
  // 只处理音频流，忽略封面/视频附件
  args.push('-map', '0:a:0', '-vn')
  if (opts.preserveMetadata) args.push('-map_metadata', '0')
  // 编码器与比特率
  switch (opts.targetFormat) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame')
      // 确保使用 ID3v2.3，避免中文乱码（ID3v1 不支持 Unicode）
      args.push('-id3v2_version', '3')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'flac':
      args.push('-c:a', 'flac')
      break
    case 'wav':
      args.push('-c:a', 'pcm_s16le')
      // WAV 默认 RIFF LIST/INFO 非 Unicode，改用 ID3v2.3
      if (opts.preserveMetadata) {
        args.push('-write_id3v2', '1', '-id3v2_version', '3')
      }
      break
    case 'aiff':
      // AIFF 常用大端 PCM；如需与特定设备兼容可改成 pcm_s16le
      args.push('-c:a', 'pcm_s16be')
      // AIFF 也启用 ID3v2.3 存储标签，保证中文
      if (opts.preserveMetadata) {
        args.push('-write_id3v2', '1', '-id3v2_version', '3')
      }
      break
    case 'aif':
      args.push('-c:a', 'pcm_s16be')
      // 与 AIFF 保持一致，启用 ID3v2.3
      if (opts.preserveMetadata) {
        args.push('-write_id3v2', '1', '-id3v2_version', '3')
      }
      break
    case 'aac':
      args.push('-c:a', 'aac')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'm4a':
    case 'mp4':
      args.push('-c:a', 'aac')
      if (!channelsApplied) applyChannels(2)
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      // m4a/mp4 容器
      args.push('-movflags', '+use_metadata_tags')
      break
    case 'ogg':
      // 选择 Vorbis 作为编码（更通用）
      args.push('-c:a', 'libvorbis')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'opus':
      {
        const OPUS_SUPPORTED_SAMPLE_RATES = new Set([48000, 24000, 16000, 12000, 8000])
        const fallbackSampleRate = 48000
        const desiredSampleRate =
          opts.sampleRate && OPUS_SUPPORTED_SAMPLE_RATES.has(opts.sampleRate)
            ? opts.sampleRate
            : fallbackSampleRate
        applySampleRate(desiredSampleRate)
        applyChannels(opts.channels ?? 2)
      }
      args.push('-c:a', 'libopus')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'webm':
      // WebM 使用 Opus
      applySampleRate(48000)
      if (!channelsApplied) applyChannels(2)
      if (!opts.bitrateKbps) args.push('-b:a', '160k')
      args.push('-c:a', 'libopus', '-f', 'webm', '-content_type', 'audio/webm')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'mka':
      // Matroska 容器采用 FLAC（无损，兼容性较好）
      args.push('-c:a', 'flac', '-f', 'matroska')
      break
    case 'wma':
      args.push('-c:a', 'wmav2')
      if (!channelsApplied) applyChannels(2)
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'ac3':
      args.push('-c:a', 'ac3')
      if (opts.bitrateKbps) args.push('-b:a', `${opts.bitrateKbps}k`)
      break
    case 'dts':
      args.push('-c:a', 'dca', '-strict', '-2')
      // DTS 的比特率通常固定在 768k/1536k：若未指定则给 768k
      if (opts.bitrateKbps) {
        args.push('-b:a', `${opts.bitrateKbps}k`)
      } else {
        args.push('-b:a', '768k')
      }
      break
    case 'wv':
      args.push('-c:a', 'wavpack')
      break
    case 'tta':
      args.push('-c:a', 'tta')
      break
  }
  if (!sampleRateApplied && opts.sampleRate) {
    applySampleRate(opts.sampleRate)
  }
  if (!channelsApplied && opts.channels) {
    applyChannels(opts.channels)
  }
  // 进度：简单采用 -hide_banner -nostats；百分比将按文件计数汇总，由 UI 侧显示
  args.push(dest)
  return args
}

// 列出当前 FFmpeg 可用的音频编码器，返回可作为目标格式的扩展集合
export async function listAvailableTargetFormats(): Promise<SupportedAudioFormat[]> {
  const ffmpegPath = resolveBundledFfmpegPath()
  await ensureExecutableOnMac(ffmpegPath)
  const out = child_process
    .execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], {
      windowsHide: true
    })
    .toString()

  const availableEncoders = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    if (!line || line.startsWith('Encoders:') || line.startsWith('------')) continue
    const trimmed = line.trim()
    if (!trimmed || !/^[AVS]/.test(trimmed)) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2) {
      availableEncoders.add(parts[1])
    }
  }

  const uniqueFormats = new Set<SupportedAudioFormat>()
  for (const fmt of SUPPORTED_AUDIO_FORMATS) {
    const requirements = ENCODER_REQUIREMENTS[fmt] || []
    if (
      requirements.length === 0 ||
      requirements.some((encoder) => availableEncoders.has(encoder))
    ) {
      if (fmt === 'dts' && !availableEncoders.has('dca')) continue
      uniqueFormats.add(fmt)
    }
  }

  const result = SUPPORTED_AUDIO_FORMATS.filter((fmt) => uniqueFormats.has(fmt))
  return result
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
        isInitial: files.length === 0
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
    let lastFfmpegArgs: string[] = []
    let lastFfmpegStderr = ''
    let tmpPaths: string[] = []
    try {
      // 同格式跳过（aif/aiff 互认为同类）
      const ext = path.extname(src).toLowerCase()
      const tgt = options.targetFormat
      const isAifFamily = (e: string) => e === '.aif' || e === '.aiff'
      const sameFormat =
        (tgt === 'mp3' && ext === '.mp3') ||
        (tgt === 'flac' && ext === '.flac') ||
        (tgt === 'wav' && ext === '.wav') ||
        ((tgt === 'aif' || tgt === 'aiff') && isAifFamily(ext)) ||
        (tgt === 'ogg' && ext === '.ogg') ||
        (tgt === 'opus' && ext === '.opus') ||
        (tgt === 'aac' && ext === '.aac') ||
        (tgt === 'm4a' && ext === '.m4a') ||
        (tgt === 'mp4' && ext === '.mp4') ||
        (tgt === 'wma' && ext === '.wma') ||
        (tgt === 'ac3' && ext === '.ac3') ||
        (tgt === 'dts' && ext === '.dts') ||
        (tgt === 'mka' && ext === '.mka') ||
        (tgt === 'webm' && ext === '.webm') ||
        (tgt === 'wv' && ext === '.wv') ||
        (tgt === 'tta' && ext === '.tta')
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
          lastFfmpegArgs = args
          tmpPaths.push(tmp)
          const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
          jobIdToChildren.set(jobId, child)
          let stderrData = ''
          child.stderr?.on('data', (chunk) => {
            stderrData += chunk.toString()
          })
          await new Promise<void>((resolve, reject) => {
            child.on('error', (err) => {
              lastFfmpegStderr = stderrData
              reject(err)
            })
            child.on('exit', (code) => {
              if (code === 0) {
                resolve()
              } else {
                lastFfmpegStderr = stderrData
                reject(new Error(`ffmpeg exit ${code}`))
              }
            })
          })
          // 备份并覆盖
          const { descriptionJson } = await backupOriginalIfNeeded(src)
          backupCount += 1
          await fs.move(tmp, dest, { overwrite: true })
          overwritten += 1
          // Windows: 追加 LIST/INFO（GBK）
          try {
            if (
              process.platform === 'win32' &&
              options.targetFormat === 'wav' &&
              options.preserveMetadata
            ) {
              const mm = await import('music-metadata')
              const meta = await mm.parseFile(src).catch(() => null)
              const common = (meta as any)?.common || {}
              await writeWavRiffInfoWindows(dest, {
                title: typeof common.title === 'string' ? common.title : undefined,
                artist: typeof common.artist === 'string' ? common.artist : undefined,
                album: typeof common.album === 'string' ? common.album : undefined,
                genre: Array.isArray(common.genre) ? common.genre[0] : common.genre,
                date:
                  typeof common.year === 'number'
                    ? String(common.year)
                    : typeof common.date === 'string'
                      ? common.date
                      : undefined,
                comment: Array.isArray(common.comment)
                  ? (common.comment.find((c: any) => typeof c === 'string' && c.trim() !== '') as
                      | string
                      | undefined)
                  : typeof common.comment === 'string'
                    ? common.comment
                    : undefined
              })
            }
          } catch {}
        } else {
          // 同格式重新编码直接覆盖：备份原文件，再输出到原路径
          const tmp = path.join(
            path.dirname(src),
            `.${path.basename(src)}.tmp.${options.targetFormat}`
          )
          const args = buildFfmpegArgs(src, tmp, options)
          lastFfmpegArgs = args
          tmpPaths.push(tmp)
          const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
          jobIdToChildren.set(jobId, child)
          let stderrData = ''
          child.stderr?.on('data', (chunk) => {
            stderrData += chunk.toString()
          })
          await new Promise<void>((resolve, reject) => {
            child.on('error', (err) => {
              lastFfmpegStderr = stderrData
              reject(err)
            })
            child.on('exit', (code) => {
              if (code === 0) {
                resolve()
              } else {
                lastFfmpegStderr = stderrData
                reject(new Error(`ffmpeg exit ${code}`))
              }
            })
          })
          await backupOriginalIfNeeded(src)
          backupCount += 1
          await fs.move(tmp, src, { overwrite: true })
          dest = src
          overwritten += 1
          // Windows: 追加 LIST/INFO（GBK）
          try {
            if (
              process.platform === 'win32' &&
              options.targetFormat === 'wav' &&
              options.preserveMetadata
            ) {
              const mm = await import('music-metadata')
              const meta = await mm.parseFile(src).catch(() => null)
              const common = (meta as any)?.common || {}
              await writeWavRiffInfoWindows(dest, {
                title: typeof common.title === 'string' ? common.title : undefined,
                artist: typeof common.artist === 'string' ? common.artist : undefined,
                album: typeof common.album === 'string' ? common.album : undefined,
                genre: Array.isArray(common.genre) ? common.genre[0] : common.genre,
                date:
                  typeof common.year === 'number'
                    ? String(common.year)
                    : typeof common.date === 'string'
                      ? common.date
                      : undefined,
                comment: Array.isArray(common.comment)
                  ? (common.comment.find((c: any) => typeof c === 'string' && c.trim() !== '') as
                      | string
                      | undefined)
                  : typeof common.comment === 'string'
                    ? common.comment
                    : undefined
              })
            }
          } catch {}
        }
      } else {
        dest = buildNonConflictTarget(src, options.targetFormat)
        const tmp = path.join(
          path.dirname(dest),
          `.${path.basename(dest)}.tmp.${options.targetFormat}`
        )
        const args = buildFfmpegArgs(src, tmp, options)
        lastFfmpegArgs = args
        tmpPaths.push(tmp)
        const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
        jobIdToChildren.set(jobId, child)
        let stderrData = ''
        child.stderr?.on('data', (chunk) => {
          stderrData += chunk.toString()
        })
        await new Promise<void>((resolve, reject) => {
          child.on('error', (err) => {
            lastFfmpegStderr = stderrData
            reject(err)
          })
          child.on('error', (err) => {
            lastFfmpegStderr = stderrData
            reject(err)
          })
          child.on('exit', (code) => {
            if (code === 0) {
              resolve()
            } else {
              lastFfmpegStderr = stderrData
              reject(new Error(`ffmpeg exit ${code}`))
            }
          })
        })
        await fs.move(tmp, dest, { overwrite: false })
        // Windows: 追加 LIST/INFO（GBK），兼容 foobar2000/资源管理器
        try {
          if (
            process.platform === 'win32' &&
            options.targetFormat === 'wav' &&
            options.preserveMetadata
          ) {
            const mm = await import('music-metadata')
            const meta = await mm.parseFile(src).catch(() => null)
            const common = (meta as any)?.common || {}
            await writeWavRiffInfoWindows(dest, {
              title: typeof common.title === 'string' ? common.title : undefined,
              artist: typeof common.artist === 'string' ? common.artist : undefined,
              album: typeof common.album === 'string' ? common.album : undefined,
              genre: Array.isArray(common.genre) ? common.genre[0] : common.genre,
              date:
                typeof common.year === 'number'
                  ? String(common.year)
                  : typeof common.date === 'string'
                    ? common.date
                    : undefined,
              comment: Array.isArray(common.comment)
                ? (common.comment.find((c: any) => typeof c === 'string' && c.trim() !== '') as
                    | string
                    | undefined)
                : typeof common.comment === 'string'
                  ? common.comment
                  : undefined
            })
          }
        } catch {}
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

      // 校验输出是否为空（或未生成）
      try {
        const outputPath =
          options.strategy === 'new_file' ? dest : options.strategy === 'replace' ? dest : ''
        if (outputPath) {
          const stat = await fs.stat(outputPath)
          if (!stat || stat.size === 0) {
            throw new Error('converted file is empty')
          }
        }
      } catch (err) {
        failed += 1
        success -= 1
        await Promise.all(
          tmpPaths.map(async (tmpPath) => {
            try {
              await fs.remove(tmpPath)
            } catch {}
          })
        )
        if (options.strategy === 'new_file') {
          try {
            await fs.remove(dest)
          } catch {}
        }
        if (mainWindow) mainWindow.webContents.send('audio:convert:progress', { jobId })
        return
      }

      if (mainWindow) mainWindow.webContents.send('audio:convert:progress', { jobId })
    } catch (e) {
      failed += 1
      // 清理临时文件
      for (const tmpPath of tmpPaths) {
        try {
          await fs.remove(tmpPath)
        } catch {}
      }
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
