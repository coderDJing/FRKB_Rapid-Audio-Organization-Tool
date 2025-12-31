import {
  extractOpenL3Embedding,
  extractSelectionBpmKeyFeatures,
  extractSelectionEssentiaFeatures,
  type UpsertSongFeaturesInput
} from 'rust_package'
import { app } from 'electron'
import { spawn } from 'child_process'
import fs = require('fs-extra')
import os = require('os')
import path = require('path')
import { ensureFpcalcExecutable, resolveBundledFpcalcPath } from '../chromaprint'
import { ensureOpenL3ModelReady } from '../openl3'

const DEFAULT_MODEL_VERSION = 'selection_features_v2'
const DEFAULT_MAX_ANALYZE_SECONDS = 120
const DEFAULT_BPM_KEY_MAX_ANALYZE_SECONDS = 15
const DEFAULT_OPENL3_MAX_WINDOWS = 64
const DECODE_TIMEOUT_MS = 120_000
const META_TIMEOUT_MS = 10_000
const OPENL3_TIMEOUT_MS = 300_000
const FPCALC_TIMEOUT = 45_000

const IS_DEV = !app.isPackaged
const devLog = (message: string): void => {
  if (IS_DEV) console.log(message)
}

let openl3InitPromise: Promise<{
  modelPath: string
  modelVersion: string
} | null> | null = null
let openl3Ready: {
  modelPath: string
  modelVersion: string
} | null = null

async function getOpenL3ModelPath(): Promise<string | null> {
  if (openl3Ready?.modelPath) return openl3Ready.modelPath
  if (!openl3InitPromise) {
    openl3InitPromise = ensureOpenL3ModelReady().catch(() => null)
  }
  openl3Ready = await openl3InitPromise
  return openl3Ready?.modelPath || null
}

export type SelectionFeatureSourceItem = {
  songId: string
  filePath: string
  fileHash?: string
}

export type SelectionFeatureExtractReportItem = {
  songId: string
  filePath: string
  ok: boolean
  error?: string
  openl3?: 'skipped' | 'ok' | 'failed'
  openl3Error?: string
  elapsedMs?: number
}

export type SelectionBpmKeyExtractReportItem = {
  songId: string
  filePath: string
  ok: boolean
  error?: string
  elapsedMs?: number
}

const TIMING_LOG_PATH = path.join(os.homedir(), 'Desktop', 'frkb-selection-timing.txt')

const logTiming = (tag: string, payload: Record<string, any>) => {
  try {
    const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(payload)}\n`
    void fs.appendFile(TIMING_LOG_PATH, line)
  } catch {}
}

export async function buildSelectionSongFeaturePatches(
  items: SelectionFeatureSourceItem[],
  options?: {
    modelVersion?: string
    maxAnalyzeSeconds?: number
  }
): Promise<{ patches: UpsertSongFeaturesInput[]; report: SelectionFeatureExtractReportItem[] }> {
  const modelVersion =
    typeof options?.modelVersion === 'string' && options.modelVersion.trim()
      ? options.modelVersion.trim()
      : DEFAULT_MODEL_VERSION
  const maxAnalyzeSeconds =
    typeof options?.maxAnalyzeSeconds === 'number' && options.maxAnalyzeSeconds > 0
      ? options.maxAnalyzeSeconds
      : DEFAULT_MAX_ANALYZE_SECONDS

  const patches: UpsertSongFeaturesInput[] = []
  const report: SelectionFeatureExtractReportItem[] = []

  for (const item of items) {
    const songId = typeof item?.songId === 'string' ? item.songId.trim() : ''
    const filePath = typeof item?.filePath === 'string' ? item.filePath : ''
    if (!songId || !filePath) {
      continue
    }

    const fileHash =
      typeof item?.fileHash === 'string' && item.fileHash.trim() ? item.fileHash.trim() : songId

    const basePatch: UpsertSongFeaturesInput = {
      songId,
      fileHash,
      modelVersion
    }

    const startedAt = Date.now()
    devLog(`[selection] 特征提取：开始 songId=${songId} 最大分析秒数=${String(maxAnalyzeSeconds)}`)

    const metaTask = (async () => {
      const at = Date.now()
      devLog(`[selection] 特征提取：读取元数据开始 songId=${songId}`)
      try {
        const meta = await withTimeout(
          readAudioFormatMeta(filePath),
          META_TIMEOUT_MS,
          '读取元数据超时'
        )
        devLog(
          `[selection] 特征提取：读取元数据完成 songId=${songId} (${Date.now() - at}ms) bitrateKbps=${String(
            meta?.bitrateKbps ?? ''
          )} durationSec=${String(meta?.durationSec ?? '')}`
        )
        return { meta, ok: true as const, error: null as string | null }
      } catch (e: any) {
        devLog(
          `[selection] 特征提取：读取元数据失败 songId=${songId} (${Date.now() - at}ms) error=${String(
            e?.message || e
          )}`
        )
        return { meta: null, ok: false as const, error: String(e?.message || e) }
      }
    })()

    const fpTask = (async () => {
      const at = Date.now()
      devLog(
        `[selection] 特征提取：fpcalc 开始 songId=${songId} maxSeconds=${String(maxAnalyzeSeconds)}`
      )
      try {
        const fp = await runFpcalcFingerprint(filePath, maxAnalyzeSeconds)
        devLog(
          `[selection] 特征提取：fpcalc 完成 songId=${songId} (${Date.now() - at}ms) len=${String(
            fp.length
          )}`
        )
        return { fp, ok: true as const, error: null as string | null }
      } catch (e: any) {
        devLog(
          `[selection] 特征提取：fpcalc 失败 songId=${songId} (${Date.now() - at}ms) error=${String(
            e?.message || e
          )}`
        )
        return { fp: null as string | null, ok: false as const, error: String(e?.message || e) }
      }
    })()

    const openl3Task = (async () => {
      const modelPath = await getOpenL3ModelPath()
      if (!modelPath) {
        return { openl3: 'skipped' as const, vec: null as Buffer | null, error: 'MODEL_NOT_READY' }
      }
      const at = Date.now()
      devLog(
        `[selection] 特征提取：OpenL3 开始 songId=${songId} maxWindows=${DEFAULT_OPENL3_MAX_WINDOWS}`
      )
      try {
        const vec = await withTimeout(
          extractOpenL3Embedding(filePath, maxAnalyzeSeconds, DEFAULT_OPENL3_MAX_WINDOWS),
          OPENL3_TIMEOUT_MS,
          'OpenL3 推理超时'
        )
        const ms = Date.now() - at
        const dim = vec?.byteLength ? Math.floor(vec.byteLength / 4) : 0
        devLog(
          `[selection] 特征提取：OpenL3 完成 songId=${songId} (${ms}ms) bytes=${vec?.byteLength || 0} dim=${dim}`
        )
        return { openl3: 'ok' as const, vec, error: null as string | null }
      } catch (e: any) {
        const ms = Date.now() - at
        devLog(
          `[selection] 特征提取：OpenL3 失败 songId=${songId} (${ms}ms) error=${String(e?.message || e)}`
        )
        return {
          openl3: 'failed' as const,
          vec: null as Buffer | null,
          error: String(e?.message || e)
        }
      }
    })()

    try {
      const calcAt = Date.now()
      const audioRes = await withTimeout(
        extractSelectionEssentiaFeatures(filePath, maxAnalyzeSeconds),
        DECODE_TIMEOUT_MS,
        '音频分析超时'
      )
      const rmsMean =
        typeof audioRes?.rmsMean === 'number' && Number.isFinite(audioRes.rmsMean)
          ? audioRes.rmsMean
          : null
      const bpm =
        typeof audioRes?.bpm === 'number' && Number.isFinite(audioRes.bpm) ? audioRes.bpm : null
      const key =
        typeof audioRes?.key === 'string' && audioRes.key.trim()
          ? String(audioRes.key).trim()
          : null
      const hpcp = Buffer.isBuffer(audioRes?.hpcp) ? audioRes.hpcp : null
      const essentiaVector = Buffer.isBuffer(audioRes?.essentiaVector)
        ? audioRes.essentiaVector
        : null
      const durationSec =
        typeof audioRes?.durationSec === 'number' && Number.isFinite(audioRes.durationSec)
          ? audioRes.durationSec
          : null
      devLog(
        `[selection] 特征提取：音频特征完成 songId=${songId} (${Date.now() - calcAt}ms) rmsMean=${String(
          rmsMean ?? ''
        )} bpm=${String(bpm ?? '')} key=${String(key ?? '')} hpcpBytes=${String(
          hpcp?.byteLength || 0
        )} essentiaBytes=${String(essentiaVector?.byteLength || 0)}`
      )

      patches.push({
        ...basePatch,
        rmsMean: rmsMean ?? undefined,
        hpcp: hpcp ?? undefined,
        bpm: bpm ?? undefined,
        key: key ?? undefined,
        essentiaVector: essentiaVector ?? undefined,
        durationSec: durationSec && durationSec > 0 ? durationSec : undefined
      })
      report.push({ songId, filePath, ok: true })
    } catch (error: any) {
      patches.push(basePatch)
      report.push({
        songId,
        filePath,
        ok: false,
        error: String(error?.message || error)
      })
    }

    // bitrateKbps / durationSec 尝试独立读取（即便解码失败也尽量补齐）
    const lastPatch = patches[patches.length - 1]
    const metaRes = await metaTask
    if (metaRes.ok && metaRes.meta) {
      if (typeof metaRes.meta?.bitrateKbps === 'number') {
        lastPatch.bitrateKbps = metaRes.meta.bitrateKbps
      }
      // durationSec 优先使用容器/元数据时长，避免被 decodeAudioFileLimited 截断
      if (typeof metaRes.meta?.durationSec === 'number') {
        lastPatch.durationSec = metaRes.meta.durationSec
      }
    }

    // Chromaprint fingerprint：独立提取（即便解码失败也尽量补齐）
    const fpRes = await fpTask
    if (fpRes.ok && typeof fpRes.fp === 'string' && fpRes.fp) {
      lastPatch.chromaprintFingerprint = fpRes.fp
    }

    // OpenL3 embedding：若应用侧模型已就绪则提取并落库（f32 LE BLOB）
    const lastReport = report[report.length - 1]
    const openl3Res = await openl3Task
    if (lastReport) {
      lastReport.openl3 = openl3Res.openl3
      if (openl3Res.error) lastReport.openl3Error = openl3Res.error
    }
    if (openl3Res.openl3 === 'ok' && Buffer.isBuffer(openl3Res.vec) && openl3Res.vec.length > 0) {
      lastPatch.openl3Vector = openl3Res.vec
    } else if (openl3Res.openl3 === 'ok') {
      if (lastReport) {
        lastReport.openl3 = 'failed'
        lastReport.openl3Error = 'EMPTY_VECTOR'
      }
    }

    const openl3Head = (() => {
      const buf = lastPatch.openl3Vector
      if (!Buffer.isBuffer(buf) || buf.byteLength < 4) return ''
      const n = Math.min(8, Math.floor(buf.byteLength / 4))
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        out.push(buf.readFloatLE(i * 4))
      }
      return out.map((v) => v.toFixed(4)).join(',')
    })()

    const elapsedMs = Date.now() - startedAt
    if (lastReport) lastReport.elapsedMs = elapsedMs
    logTiming('features:timing', {
      songId,
      filePath,
      ms: elapsedMs,
      ok: lastReport?.ok === true,
      openl3: lastReport?.openl3
    })
    devLog(
      `[selection] 特征提取：结果 songId=${songId} (${elapsedMs}ms) rmsMean=${String(
        lastPatch.rmsMean ?? ''
      )} bpm=${String(lastPatch.bpm ?? '')} key=${String(lastPatch.key ?? '')} durationSec=${String(
        lastPatch.durationSec ?? ''
      )} bitrateKbps=${String(lastPatch.bitrateKbps ?? '')} hpcpBytes=${String(
        (lastPatch.hpcp as any)?.byteLength || 0
      )} essentiaBytes=${String((lastPatch.essentiaVector as any)?.byteLength || 0)} chromaprintLen=${String(
        lastPatch.chromaprintFingerprint?.length || 0
      )} openl3Bytes=${String(
        (lastPatch.openl3Vector as any)?.byteLength || 0
      )} openl3=${String(lastReport?.openl3 || '')} openl3Head=${openl3Head}`
    )
  }

  return { patches, report }
}

export async function buildSelectionSongBpmKeyPatches(
  items: SelectionFeatureSourceItem[],
  options?: {
    modelVersion?: string
    maxAnalyzeSeconds?: number
  }
): Promise<{ patches: UpsertSongFeaturesInput[]; report: SelectionBpmKeyExtractReportItem[] }> {
  const modelVersion =
    typeof options?.modelVersion === 'string' && options.modelVersion.trim()
      ? options.modelVersion.trim()
      : DEFAULT_MODEL_VERSION
  const maxAnalyzeSeconds =
    typeof options?.maxAnalyzeSeconds === 'number' && options.maxAnalyzeSeconds > 0
      ? options.maxAnalyzeSeconds
      : DEFAULT_BPM_KEY_MAX_ANALYZE_SECONDS

  const patches: UpsertSongFeaturesInput[] = []
  const report: SelectionBpmKeyExtractReportItem[] = []

  for (const item of items) {
    const songId = typeof item?.songId === 'string' ? item.songId.trim() : ''
    const filePath = typeof item?.filePath === 'string' ? item.filePath : ''
    if (!songId || !filePath) {
      continue
    }

    const fileHash =
      typeof item?.fileHash === 'string' && item.fileHash.trim() ? item.fileHash.trim() : songId

    const basePatch: UpsertSongFeaturesInput = {
      songId,
      fileHash,
      modelVersion
    }

    const startedAt = Date.now()
    devLog(`[selection] BPM/调性：开始 songId=${songId} 最大分析秒数=${String(maxAnalyzeSeconds)}`)

    try {
      const audioRes = await withTimeout(
        extractSelectionBpmKeyFeatures(filePath, maxAnalyzeSeconds),
        DECODE_TIMEOUT_MS,
        '音频分析超时'
      )
      const bpm =
        typeof audioRes?.bpm === 'number' && Number.isFinite(audioRes.bpm) ? audioRes.bpm : null
      const key =
        typeof audioRes?.key === 'string' && audioRes.key.trim()
          ? String(audioRes.key).trim()
          : null

      const elapsedMs = Date.now() - startedAt
      patches.push({
        ...basePatch,
        bpm: typeof bpm === 'number' && Number.isFinite(bpm) ? bpm : undefined,
        key: key ?? undefined
      })
      report.push({ songId, filePath, ok: true, elapsedMs })
      logTiming('bpmKey:timing', {
        songId,
        filePath,
        ms: elapsedMs,
        ok: true,
        bpm,
        key
      })
      devLog(
        `[selection] BPM/调性：完成 songId=${songId} (${elapsedMs}ms) bpm=${String(
          bpm ?? ''
        )} key=${String(key ?? '')}`
      )
    } catch (error: any) {
      const elapsedMs = Date.now() - startedAt
      patches.push(basePatch)
      report.push({
        songId,
        filePath,
        ok: false,
        error: String(error?.message || error),
        elapsedMs
      })
      logTiming('bpmKey:timing', {
        songId,
        filePath,
        ms: elapsedMs,
        ok: false,
        error: String(error?.message || error)
      })
    }
  }

  return { patches, report }
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readAudioFormatMeta(
  filePath: string
): Promise<{ bitrateKbps: number | null; durationSec: number | null }> {
  const mm = await import('music-metadata')
  const meta = await mm.parseFile(filePath)

  const bitrate = meta?.format?.bitrate
  const duration = meta?.format?.duration

  const bitrateKbps =
    typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0
      ? Math.round((bitrate / 1000) * 10) / 10
      : null

  const durationSec =
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null

  return { bitrateKbps, durationSec }
}

async function runFpcalcFingerprint(filePath: string, maxLengthSeconds: number): Promise<string> {
  const fpcalcPath = process.env.FRKB_FPCALC_PATH || resolveBundledFpcalcPath()
  if (!fpcalcPath || !(await fs.pathExists(fpcalcPath))) {
    throw new Error('FPCALC_NOT_FOUND')
  }
  await ensureFpcalcExecutable(fpcalcPath)

  const targetLength = maxLengthSeconds > 0 ? Math.round(maxLengthSeconds) : 120
  const args = ['-json', '-length', String(targetLength), filePath]
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(fpcalcPath, args, { windowsHide: true })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error('FPCALC_TIMEOUT'))
    }, FPCALC_TIMEOUT)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (err: any) => {
      clearTimeout(timer)
      if (err && err.code === 'ENOENT') {
        reject(new Error('FPCALC_NOT_FOUND'))
      } else {
        reject(err)
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const error = stderr || `fpcalc exit ${code}`
        reject(new Error(`FPCALC_FAILED:${error}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        const fingerprint = parsed?.fingerprint
        if (!fingerprint || typeof fingerprint !== 'string') {
          reject(new Error('FPCALC_NO_FINGERPRINT'))
          return
        }
        resolve(fingerprint)
      } catch {
        reject(new Error('FPCALC_PARSE_ERROR'))
      }
    })
  })
}
