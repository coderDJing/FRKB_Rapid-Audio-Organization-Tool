import {
  decodeAudioFileLimited,
  extractOpenL3Embedding,
  type UpsertSongFeaturesInput
} from 'rust_package'
import { spawn } from 'child_process'
import fs = require('fs-extra')
import { ensureFpcalcExecutable, resolveBundledFpcalcPath } from '../chromaprint'
import { ensureOpenL3ModelReady } from '../openl3'
import { log } from '../log'

const Meyda = require('meyda')

const DEFAULT_MODEL_VERSION = 'selection_features_v1'
const DEFAULT_MAX_ANALYZE_SECONDS = 120
const DEFAULT_OPENL3_MAX_WINDOWS = 64
const INTRO_SKIP_SECONDS = 30
const CHROMA_MAX_FRAMES = 400
const DECODE_TIMEOUT_MS = 120_000
const META_TIMEOUT_MS = 10_000
const OPENL3_TIMEOUT_MS = 300_000
const FPCALC_TIMEOUT = 45_000

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
    log.debug(
      `[selection] 特征提取：开始 songId=${songId} 最大分析秒数=${String(maxAnalyzeSeconds)}`
    )

    const metaTask = (async () => {
      const at = Date.now()
      log.debug(`[selection] 特征提取：读取元数据开始 songId=${songId}`)
      try {
        const meta = await withTimeout(
          readAudioFormatMeta(filePath),
          META_TIMEOUT_MS,
          '读取元数据超时'
        )
        log.debug(
          `[selection] 特征提取：读取元数据完成 songId=${songId} (${Date.now() - at}ms) bitrateKbps=${String(
            meta?.bitrateKbps ?? ''
          )} durationSec=${String(meta?.durationSec ?? '')}`
        )
        return { meta, ok: true as const, error: null as string | null }
      } catch (e: any) {
        log.debug(
          `[selection] 特征提取：读取元数据失败 songId=${songId} (${Date.now() - at}ms) error=${String(
            e?.message || e
          )}`
        )
        return { meta: null, ok: false as const, error: String(e?.message || e) }
      }
    })()

    const fpTask = (async () => {
      const at = Date.now()
      log.debug(
        `[selection] 特征提取：fpcalc 开始 songId=${songId} maxSeconds=${String(maxAnalyzeSeconds)}`
      )
      try {
        const fp = await runFpcalcFingerprint(filePath, maxAnalyzeSeconds)
        log.debug(
          `[selection] 特征提取：fpcalc 完成 songId=${songId} (${Date.now() - at}ms) len=${String(
            fp.length
          )}`
        )
        return { fp, ok: true as const, error: null as string | null }
      } catch (e: any) {
        log.debug(
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
      log.debug(
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
        log.debug(
          `[selection] 特征提取：OpenL3 完成 songId=${songId} (${ms}ms) bytes=${vec?.byteLength || 0} dim=${dim}`
        )
        return { openl3: 'ok' as const, vec, error: null as string | null }
      } catch (e: any) {
        const ms = Date.now() - at
        log.debug(
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
      const decodeAt = Date.now()
      log.debug(`[selection] 特征提取：解码开始 songId=${songId}`)
      const decoded = await withTimeout(
        decodeAudioFileLimited(filePath, maxAnalyzeSeconds),
        DECODE_TIMEOUT_MS,
        '音频解码超时'
      )
      if (decoded?.error) throw new Error(decoded.error)
      log.debug(
        `[selection] 特征提取：解码完成 songId=${songId} (${Date.now() - decodeAt}ms) sr=${String(
          decoded.sampleRate
        )} ch=${String(decoded.channels)} frames=${String(decoded.totalFrames)} bytes=${String(
          decoded.pcmData?.byteLength || 0
        )}`
      )

      const channels = Math.max(1, Number(decoded.channels || 1))
      const sampleRate = Math.max(1, Number(decoded.sampleRate || 0))
      const totalFrames = Math.max(0, Number(decoded.totalFrames || 0))
      const durationSec = totalFrames > 0 ? totalFrames / sampleRate : 0

      const pcm = toFloat32ArrayView(decoded.pcmData)
      const maxFrames = Math.min(
        totalFrames > 0 ? totalFrames : Math.floor(pcm.length / channels),
        Math.floor(sampleRate * maxAnalyzeSeconds)
      )
      const mono = downmixToMono(pcm, channels, maxFrames)

      const introSkipFrames = Math.max(0, Math.floor(sampleRate * INTRO_SKIP_SECONDS))
      const shouldSkipIntro = mono.length - introSkipFrames >= sampleRate
      const featureSignal = shouldSkipIntro ? mono.subarray(introSkipFrames) : mono

      const calcAt = Date.now()
      const rmsMean = computeRmsMean(featureSignal)
      const hpcpVec = computeMeanChroma(featureSignal, sampleRate)
      const key = hpcpVec ? detectKeyFromChroma(hpcpVec) : null
      const bpm = estimateBpmFromSignal(featureSignal, sampleRate)
      log.debug(
        `[selection] 特征提取：音频特征完成 songId=${songId} (${Date.now() - calcAt}ms) skipIntroSec=${
          shouldSkipIntro ? INTRO_SKIP_SECONDS : 0
        } rmsMean=${String(rmsMean ?? '')} bpm=${String(bpm ?? '')} key=${String(key ?? '')} hpcp=${
          hpcpVec ? hpcpVec.map((v) => Number(v || 0).toFixed(3)).join(',') : ''
        }`
      )

      patches.push({
        ...basePatch,
        rmsMean: rmsMean ?? undefined,
        hpcp: hpcpVec ? f32ArrayToLEBuffer(hpcpVec) : undefined,
        bpm: bpm ?? undefined,
        key: key ?? undefined,
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined
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

    log.debug(
      `[selection] 特征提取：结果 songId=${songId} (${Date.now() - startedAt}ms) rmsMean=${String(
        lastPatch.rmsMean ?? ''
      )} bpm=${String(lastPatch.bpm ?? '')} key=${String(lastPatch.key ?? '')} durationSec=${String(
        lastPatch.durationSec ?? ''
      )} bitrateKbps=${String(lastPatch.bitrateKbps ?? '')} hpcpBytes=${String(
        (lastPatch.hpcp as any)?.byteLength || 0
      )} chromaprintLen=${String(lastPatch.chromaprintFingerprint?.length || 0)} openl3Bytes=${String(
        (lastPatch.openl3Vector as any)?.byteLength || 0
      )} openl3=${String(lastReport?.openl3 || '')} openl3Head=${openl3Head}`
    )
  }

  return { patches, report }
}

function toFloat32ArrayView(pcmData: unknown): Float32Array {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(pcmData)) {
    const buffer = pcmData as Buffer
    return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
  }
  if (pcmData instanceof Uint8Array) {
    return new Float32Array(pcmData.buffer, pcmData.byteOffset, Math.floor(pcmData.byteLength / 4))
  }
  return new Float32Array(0)
}

function downmixToMono(
  pcmInterleaved: Float32Array,
  channels: number,
  frames: number
): Float32Array {
  const outFrames = Math.max(0, Math.min(frames, Math.floor(pcmInterleaved.length / channels)))
  const mono = new Float32Array(outFrames)
  if (outFrames === 0) return mono

  if (channels === 1) {
    mono.set(pcmInterleaved.subarray(0, outFrames))
    return mono
  }

  for (let frameIndex = 0; frameIndex < outFrames; frameIndex++) {
    let sum = 0
    const base = frameIndex * channels
    for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
      sum += pcmInterleaved[base + channelIndex] || 0
    }
    mono[frameIndex] = sum / channels
  }
  return mono
}

function computeRmsMean(signal: Float32Array): number | null {
  if (!signal.length) return null
  let sum = 0
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i] || 0
    sum += v * v
  }
  return Math.sqrt(sum / signal.length)
}

function computeMeanChroma(signal: Float32Array, sampleRate: number): number[] | null {
  const windowSize = 2048
  const hopSize = 1024
  if (signal.length < windowSize) return null

  Meyda.sampleRate = sampleRate
  Meyda.bufferSize = windowSize

  const acc = new Array(12).fill(0)
  let n = 0

  const totalFrames = Math.floor((signal.length - windowSize) / hopSize) + 1
  const step = totalFrames > CHROMA_MAX_FRAMES ? Math.ceil(totalFrames / CHROMA_MAX_FRAMES) : 1

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += step) {
    const offset = frameIndex * hopSize
    const frame = signal.subarray(offset, offset + windowSize)
    const features = Meyda.extract(['chroma'], frame)
    const chroma = (features as any)?.chroma as ArrayLike<number> | undefined
    if (!chroma || typeof chroma.length !== 'number' || chroma.length < 12) continue
    for (let i = 0; i < 12; i++) {
      acc[i] += Number(chroma[i] || 0)
    }
    n++
  }

  if (n <= 0) return null
  const mean = acc.map((v) => v / n)
  const norm = Math.sqrt(mean.reduce((s, v) => s + v * v, 0))
  if (norm > 0) {
    for (let i = 0; i < mean.length; i++) mean[i] = mean[i] / norm
  }
  return mean
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

function detectKeyFromChroma(chroma: number[]): string | null {
  if (!Array.isArray(chroma) || chroma.length < 12) return null
  const energy = chroma.reduce((s, v) => s + v * v, 0)
  if (energy <= 0) return null

  // Krumhansl-Schmuckler profiles
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
  const roots = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']

  const scoreFor = (profile: number[], shift: number): number => {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < 12; i++) {
      const a = chroma[i] || 0
      const b = profile[(i - shift + 12) % 12] || 0
      dot += a * b
      na += a * a
      nb += b * b
    }
    if (na <= 0 || nb <= 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

  let best = { score: 0, root: 0, mode: 'maj' as 'maj' | 'min' }
  for (let shift = 0; shift < 12; shift++) {
    const sMaj = scoreFor(major, shift)
    if (sMaj > best.score) best = { score: sMaj, root: shift, mode: 'maj' }
    const sMin = scoreFor(minor, shift)
    if (sMin > best.score) best = { score: sMin, root: shift, mode: 'min' }
  }

  const root = roots[best.root] || 'c'
  return `${root}:${best.mode}`
}

function estimateBpmFromSignal(signal: Float32Array, sampleRate: number): number | null {
  const minBpm = 60
  const maxBpm = 200
  const frameSize = 1024
  const hopSize = 512
  if (signal.length < frameSize * 4) return null

  const frameCount = Math.floor((signal.length - frameSize) / hopSize) + 1
  if (frameCount < 32) return null

  const energy = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    const start = i * hopSize
    let sum = 0
    for (let j = 0; j < frameSize; j++) {
      const v = signal[start + j] || 0
      sum += v * v
    }
    energy[i] = Math.sqrt(sum / frameSize)
  }

  // onset envelope：正向差分
  const onset = new Float32Array(frameCount)
  for (let i = 1; i < frameCount; i++) {
    const d = energy[i] - energy[i - 1]
    onset[i] = d > 0 ? d : 0
  }

  const framesPerSecond = sampleRate / hopSize
  const minLag = Math.max(1, Math.floor((60 * framesPerSecond) / maxBpm))
  const maxLag = Math.max(minLag + 1, Math.floor((60 * framesPerSecond) / minBpm))
  if (frameCount < maxLag * 2) return null

  let bestLag = 0
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < frameCount; i++) {
      sum += onset[i] * onset[i + lag]
    }
    if (sum > bestScore) {
      bestScore = sum
      bestLag = lag
    }
  }
  if (bestLag <= 0 || !Number.isFinite(bestScore) || bestScore <= 0) return null

  let bpm = (60 * framesPerSecond) / bestLag
  if (!Number.isFinite(bpm) || bpm <= 0) return null

  // 轻量修正：把结果折叠到常见展示范围
  while (bpm < 80) bpm *= 2
  while (bpm > 160) bpm /= 2

  return Math.round(bpm * 10) / 10
}

function f32ArrayToLEBuffer(values: ArrayLike<number>): Buffer {
  const n = Math.max(0, Number(values?.length || 0))
  const buffer = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    buffer.writeFloatLE(Number(values[i] || 0), i * 4)
  }
  return buffer
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
