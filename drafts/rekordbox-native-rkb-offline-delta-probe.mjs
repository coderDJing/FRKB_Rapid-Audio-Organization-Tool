#!/usr/bin/env node
// drafts/rekordbox-native-rkb-offline-delta-probe.mjs
//
// 一次性离线测量：给定 Rekordbox 提供的"已知 kick 时间点 / 网格线时间点"，
// 在 FRKB 侧解码得到的 PCM 里，找出这些参考点周围能量最大的帧，
// 计算 delta_ms，判断是否存在"普适的时间基准偏移"。
//
// 纯读脚本：
//   - 不改动任何运行时代码
//   - 不回写任何缓存
//   - 不触发任何 Electron / 主进程路径
//
// 用法（仓库根目录）：
//   node drafts/rekordbox-native-rkb-offline-delta-probe.mjs
//
// 依赖：
//   - vendor/ffmpeg/win32-x64/ffmpeg.exe （或对应平台子目录）
//   - resources/rkbRekordboxAbcGridSnapshot.json
//   - resources/rkbRekordboxAbcWaveformVisibleOnsets.json
//   - 音频文件默认位于 D:\FRKB_database-B\library\FilterLibrary\rkb
//     可通过环境变量 FRKB_RKB_AUDIO_DIR 覆盖
//
// 输出：
//   - 终端打印每首歌的总结
//   - drafts/rekordbox-native-rkb-offline-delta-probe.out.json
//     便于后续追加讨论

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

// ---- 参数 ----

// 仅解码前 DECODE_SECONDS 秒即可覆盖"前 32 拍"的测量需要。
// 140bpm 下 32 拍 ≈ 13.7s，冗余到 60s 绝对够用。
const DECODE_SECONDS = 60
const SAMPLE_RATE = 44100
// 在参考点附近搜多大的窗口内的能量峰值。
// 搜索半径太大会跨过相邻 kick，太小会把 Rekordbox 自己的误差也当信号。
// 60ms 对应 140bpm 下半拍的 ~28%，既能吃掉常见的 mp3 编码器 delay（20~50ms）
// 又不会跨到上/下一拍。
const SEARCH_RADIUS_MS = 60
// 做能量估计的窗口大小。1ms 窗足够定位鼓头。
const ENERGY_WINDOW_MS = 1
// 前多少根网格线参与"多点一致性"检验。
const GRID_BEAT_COUNT = 32
// mp3 解码器固有 delay：mpg123/lame 长期约定 = 529 samples。
// trim 量 = encoderDelay (来自 LAME tag) + MP3_DECODER_DELAY_SAMPLES。
// 这是主流"gapless 播放"实现（iTunes / foobar / Rekordbox 等）使用的同一公式。
const MP3_DECODER_DELAY_SAMPLES = 529

// ---- 四首代表歌（与 handoff 文档一致）----
// 默认只跑这四首；如果传入 --all 或设 FRKB_RKB_PROBE_ALL=1，则跑 snapshot 里全部 33 首。

const REPRESENTATIVE_FILE_NAMES = [
  'Developer - Have It All (Original Mix).mp3',
  'len faki - gamma (glaskin remix) (1).mp3',
  'lewis fautzi - diversity of known substances (original mix) (1).mp3',
  "enrico sangiuliano - the techno code (charlotte de witte's acid code) (1).mp3"
]

const isAllMode = () => {
  if (process.argv.includes('--all')) return true
  if (process.env.FRKB_RKB_PROBE_ALL === '1') return true
  return false
}

// ---- mp3 头解析（"26ms 问题"识别）----
//
// 目的：在不解码音频的前提下，分类每个 mp3 文件属于 case A/B/C/D 中哪一类，
// 以判断 Rekordbox 是否会比"朴素解码器"额外跳过第一个 MPEG 帧（约 26ms）。
//
// 算法依据（公开资料 - "26ms 问题"）：
//   case A：mp3 没有 Xing/Info 头        → 修正 = 0ms
//   case B：有 Xing/Info 但没有 LAME 子头 → 修正 = 26ms
//   case C：有 LAME 子头但 CRC 错误（含全 0） → 修正 = 26ms
//   case D：有 LAME 子头且 CRC 正确       → 修正 = 0ms
//
// CRC 计算与 LAME 源码 VbrTag.c 一致：
//   多项式 x^16+x^15+x^2+1（CRC-16/IBM, reflected, poly=0xA001, init=0x0000）
//   覆盖范围：从 mp3 frame 第 1 字节起，到 LAME tag 倒数第 2 字节（不含末尾 2B CRC 本身）

const buildCrc16Table = () => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i += 1) {
    let crc = i
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
    }
    table[i] = crc & 0xffff
  }
  return table
}

const CRC16_TABLE = buildCrc16Table()

// 一致性自检：与 LAME 源码 crc16_lookup[] 前 8 项比对，防止以后被人改坏。
const CRC16_TABLE_HEAD_EXPECTED = [
  0x0000, 0xc0c1, 0xc181, 0x0140, 0xc301, 0x03c0, 0x0280, 0xc241
]
for (let i = 0; i < CRC16_TABLE_HEAD_EXPECTED.length; i += 1) {
  if (CRC16_TABLE[i] !== CRC16_TABLE_HEAD_EXPECTED[i]) {
    throw new Error(
      `CRC16_TABLE self-check failed at index ${i}: got 0x${CRC16_TABLE[i].toString(16)}, expected 0x${CRC16_TABLE_HEAD_EXPECTED[i].toString(16)}`
    )
  }
}

const crc16Update = (crc, byte) => {
  return ((crc >>> 8) ^ CRC16_TABLE[(crc ^ byte) & 0xff]) & 0xffff
}

const crc16Compute = (buffer, start, end) => {
  let crc = 0
  for (let i = start; i < end; i += 1) {
    crc = crc16Update(crc, buffer[i])
  }
  return crc
}

// 跳过 ID3v2 标签：返回真正的 mp3 数据起点偏移。
const resolveId3v2End = (buffer) => {
  if (buffer.length < 10) return 0
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return 0
  // ID3v2 的 size 用 syncsafe 整数（每字节最高位无效）
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f)
  return 10 + size
}

// 在 mp3 数据起点附近找第一个合法 frame sync（0xFFE0 mask）。
// 读 buffer 全长，避免 ID3v2 + 大封面把第一帧推过 4KB 边界。
const findFirstFrameOffset = (buffer, searchStart) => {
  const limit = buffer.length - 1
  for (let i = searchStart; i < limit; i += 1) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
      return i
    }
  }
  return -1
}

// 解析 frame header 4 字节，返回需要的元信息。
const parseFrameHeader = (buffer, frameStart) => {
  if (frameStart + 4 > buffer.length) return null
  const b1 = buffer[frameStart]
  const b2 = buffer[frameStart + 1]
  const b3 = buffer[frameStart + 2]
  const b4 = buffer[frameStart + 3]
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null

  // version: 11=MPEG1, 10=MPEG2, 00=MPEG2.5, 01=reserved
  const versionBits = (b2 >> 3) & 0x03
  if (versionBits === 0x01) return null
  const isMpeg1 = versionBits === 0x03
  const isMpeg2 = versionBits === 0x02
  const isMpeg25 = versionBits === 0x00
  const mpegVersion = isMpeg1 ? 1 : isMpeg2 ? 2 : 2.5

  // layer: 11=I, 10=II, 01=III
  const layerBits = (b2 >> 1) & 0x03
  if (layerBits !== 0x01) return null

  // channel mode: 11=mono
  const channelMode = (b4 >> 6) & 0x03
  const isMono = channelMode === 0x03

  // 采样率
  const samplingBits = (b3 >> 2) & 0x03
  if (samplingBits === 0x03) return null
  const samplingTable = {
    1: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    2.5: [11025, 12000, 8000]
  }
  const sampleRate = samplingTable[mpegVersion][samplingBits]

  // Xing/Info/VBRI 头在 frame 数据区里的固定 offset（不含 4B header 本身）
  let sideInfoOffset
  if (isMpeg1) {
    sideInfoOffset = isMono ? 17 : 32
  } else {
    sideInfoOffset = isMono ? 9 : 17
  }

  return {
    mpegVersion,
    isMono,
    sampleRate,
    sideInfoOffset
  }
}

// 在 frame 数据区里找 Xing / Info / VBRI 标签。
// 返回 magic 在 buffer 中的绝对偏移；找不到返回 -1。
const findVbrTagOffset = (buffer, frameStart, sideInfoOffset) => {
  // magic 必须在 sideInfo 之后；不依赖精确位置，扫描小窗（足够保险）。
  const scanStart = frameStart + 4 + sideInfoOffset
  const scanEnd = Math.min(buffer.length - 4, scanStart + 64)
  for (let i = scanStart; i < scanEnd; i += 1) {
    const b1 = buffer[i]
    const b2 = buffer[i + 1]
    const b3 = buffer[i + 2]
    const b4 = buffer[i + 3]
    // "Xing"
    if (b1 === 0x58 && b2 === 0x69 && b3 === 0x6e && b4 === 0x67) return i
    // "Info"
    if (b1 === 0x49 && b2 === 0x6e && b3 === 0x66 && b4 === 0x6f) return i
  }
  return -1
}

// 从 Xing/Info magic 开始计算 LAME tag 的预期布局，并验证 CRC。
// 返回分类结果。
const classifyLameTag = (buffer, frameStart, vbrMagicOffset) => {
  // Xing/Info header 自身 4 + 4 flags + 可选 frames/bytes/toc/quality
  const flags =
    (buffer[vbrMagicOffset + 4] << 24) |
    (buffer[vbrMagicOffset + 5] << 16) |
    (buffer[vbrMagicOffset + 6] << 8) |
    buffer[vbrMagicOffset + 7]
  let cursor = vbrMagicOffset + 8
  if (flags & 0x0001) cursor += 4 // frames
  if (flags & 0x0002) cursor += 4 // bytes
  if (flags & 0x0004) cursor += 100 // TOC
  if (flags & 0x0008) cursor += 4 // quality

  // LAME tag 紧跟其后，固定 36 字节布局，末尾 2B 为 LAME info CRC。
  // 整段 LAME tag 长 36，但有效内容到 CRC 字段前为 34 字节。
  const lameTagStart = cursor
  if (lameTagStart + 36 > buffer.length) {
    return { hasLameSubTag: false, reason: 'lame_tag_truncated' }
  }
  // LAME 版本字符串前 4 字节即 "LAME"/"LAVC"/"LAVF" 等编码器标识
  const encoderMagic = String.fromCharCode(
    buffer[lameTagStart],
    buffer[lameTagStart + 1],
    buffer[lameTagStart + 2],
    buffer[lameTagStart + 3]
  )
  // LAME 子头是否真实存在：要求 9 字节版本字符串区是合理 ASCII。
  // 一些"伪 Xing"文件（典型 case B：LAVC reduced tag）整段 LAME 区为 0，编码器
  // 字符串也为 0，按算法应归入 case B（修正 26ms）。
  let asciiCount = 0
  for (let i = 0; i < 9; i += 1) {
    const c = buffer[lameTagStart + i]
    if (c >= 0x20 && c < 0x7f) asciiCount += 1
  }
  const looksLikeLameTag = asciiCount >= 4
  if (!looksLikeLameTag) {
    return { hasLameSubTag: false, encoderMagic, reason: 'no_ascii_lame_version' }
  }

  // CRC-16 校验范围：从 frame 第一个字节到 LAME tag CRC 字段前。
  const crcStart = frameStart
  const crcEnd = lameTagStart + 34
  const computedCrc = crc16Compute(buffer, crcStart, crcEnd)
  const storedCrc = (buffer[lameTagStart + 34] << 8) | buffer[lameTagStart + 35]
  const crcOk = computedCrc === storedCrc

  // 编码器 delay / padding 字段（仅作信息记录，不参与分类）
  // 位置：flags2 之前 3 字节
  const encDelayPaddingOffset = lameTagStart + 21
  const encDelayHi = buffer[encDelayPaddingOffset]
  const encDelayLoPaddingHi = buffer[encDelayPaddingOffset + 1]
  const encPaddingLo = buffer[encDelayPaddingOffset + 2]
  const encoderDelaySamples = (encDelayHi << 4) | (encDelayLoPaddingHi >> 4)
  const encoderPaddingSamples = ((encDelayLoPaddingHi & 0x0f) << 8) | encPaddingLo

  return {
    hasLameSubTag: true,
    encoderMagic,
    crcOk,
    storedCrc,
    computedCrc,
    encoderDelaySamples,
    encoderPaddingSamples
  }
}

const REKORDBOX_FRAME_SKIP_MS = 26

// 分类入口：读前 4KB，返回 case A/B/C/D + 应有修正。
const classifyMp3FromBuffer = (buffer) => {
  const id3End = resolveId3v2End(buffer)
  const frameStart = findFirstFrameOffset(buffer, id3End)
  if (frameStart < 0) {
    return { case: 'unknown', correctionMs: 0, reason: 'no_frame_sync' }
  }
  const header = parseFrameHeader(buffer, frameStart)
  if (!header) {
    return { case: 'unknown', correctionMs: 0, reason: 'invalid_frame_header' }
  }
  const vbrMagicOffset = findVbrTagOffset(buffer, frameStart, header.sideInfoOffset)
  if (vbrMagicOffset < 0) {
    return {
      case: 'A',
      correctionMs: 0,
      reason: 'no_xing_info',
      frameStart,
      header
    }
  }
  const lame = classifyLameTag(buffer, frameStart, vbrMagicOffset)
  if (!lame.hasLameSubTag) {
    return {
      case: 'B',
      correctionMs: REKORDBOX_FRAME_SKIP_MS,
      reason: lame.reason,
      frameStart,
      header,
      vbrMagicOffset,
      lame
    }
  }
  if (!lame.crcOk) {
    return {
      case: 'C',
      correctionMs: REKORDBOX_FRAME_SKIP_MS,
      reason: 'lame_crc_mismatch',
      frameStart,
      header,
      vbrMagicOffset,
      lame
    }
  }
  return {
    case: 'D',
    correctionMs: 0,
    reason: 'lame_crc_ok',
    frameStart,
    header,
    vbrMagicOffset,
    lame
  }
}

const classifyMp3File = async (filePath) => {
  // 256KB 足够覆盖：常见 ID3v2 含一张 JPEG 封面通常在 30~150KB；超过这个窗口
  // 的封面极少见，这里直接读 256KB，省得分块。
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return classifyMp3FromBuffer(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

// ---- 基础工具 ----

const resolveFfmpeg = () => {
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'vendor', 'ffmpeg', 'win32-x64', 'ffmpeg.exe')
  }
  if (process.platform === 'darwin') {
    return path.join(repoRoot, 'vendor', 'ffmpeg', 'darwin', 'ffmpeg')
  }
  return path.join(repoRoot, 'vendor', 'ffmpeg', process.platform + '-' + process.arch, 'ffmpeg')
}

const resolveFfprobe = () => {
  const ffmpeg = resolveFfmpeg()
  const dir = path.dirname(ffmpeg)
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(dir, name)
}

const readJson = async (relPath) => {
  const abs = path.resolve(repoRoot, relPath)
  const raw = await fs.readFile(abs, 'utf-8')
  return JSON.parse(raw)
}

const resolveAudioDir = () => {
  const override = process.env.FRKB_RKB_AUDIO_DIR
  if (override) return override
  return 'D:\\FRKB_database-B\\library\\FilterLibrary\\rkb'
}

// 用 ffprobe 只拿一次 start_time（只用来打印，不参与计算）
const probeStartTimeMs = async (filePath) => {
  const ffprobe = resolveFfprobe()
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'stream=index,codec_type,start_time',
      '-select_streams',
      'a:0',
      filePath
    ]
    const child = spawn(ffprobe, args, { windowsHide: true })
    const chunks = []
    child.stdout.on('data', (d) => chunks.push(d))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        const stream = json?.streams?.[0]
        const startTimeSec = Number(stream?.start_time)
        if (!Number.isFinite(startTimeSec)) return resolve(null)
        resolve(Number((startTimeSec * 1000).toFixed(3)))
      } catch {
        resolve(null)
      }
    })
  })
}

// 解码前 DECODE_SECONDS 秒为单声道 float32 PCM。
// 使用与运行时一致的 ffmpeg 可执行，避免"换个解码器 delta 就跑了"的干扰。
const decodeMonoFloat32 = async (filePath) => {
  const ffmpeg = resolveFfmpeg()
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-nostdin',
      '-i',
      filePath,
      '-t',
      String(DECODE_SECONDS),
      '-f',
      'f32le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-'
    ]
    const child = spawn(ffmpeg, args, { windowsHide: true })
    const chunks = []
    let totalBytes = 0
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk)
      totalBytes += chunk.length
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf-8')
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
        return
      }
      const buffer = Buffer.concat(chunks, totalBytes)
      // 4 bytes per float32
      const frameCount = Math.floor(buffer.byteLength / 4)
      const pcm = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        frameCount
      ).slice()
      resolve(pcm)
    })
  })
}

// 在 PCM 上做 1ms 窗能量包络。
const buildEnergyEnvelope = (pcm) => {
  const windowSamples = Math.max(1, Math.round((ENERGY_WINDOW_MS / 1000) * SAMPLE_RATE))
  const envelopeLen = Math.floor(pcm.length / windowSamples)
  const envelope = new Float32Array(envelopeLen)
  for (let i = 0; i < envelopeLen; i += 1) {
    let acc = 0
    const base = i * windowSamples
    for (let j = 0; j < windowSamples; j += 1) {
      const sample = pcm[base + j]
      acc += sample * sample
    }
    envelope[i] = acc / windowSamples
  }
  return { envelope, windowSamples }
}

// 给定一个"参考毫秒点"，在 ±SEARCH_RADIUS_MS 范围内找能量最大的包络 index。
// 返回该点的毫秒时间（以 PCM 时间为准）。
const findLocalEnergyPeakMs = (envelope, windowSamples, referenceMs) => {
  const msPerEnvelopeStep = (windowSamples / SAMPLE_RATE) * 1000
  const centerIdx = Math.round(referenceMs / msPerEnvelopeStep)
  const radiusSteps = Math.round(SEARCH_RADIUS_MS / msPerEnvelopeStep)
  const lo = Math.max(0, centerIdx - radiusSteps)
  const hi = Math.min(envelope.length - 1, centerIdx + radiusSteps)
  if (hi < lo) return null
  let bestIdx = lo
  let bestVal = envelope[lo]
  for (let i = lo + 1; i <= hi; i += 1) {
    const v = envelope[i]
    if (v > bestVal) {
      bestVal = v
      bestIdx = i
    }
  }
  return {
    peakMs: bestIdx * msPerEnvelopeStep,
    peakEnergy: bestVal,
    searchLoMs: lo * msPerEnvelopeStep,
    searchHiMs: hi * msPerEnvelopeStep
  }
}

// 计算一系列 delta 的统计量。
const summarize = (values) => {
  if (!values.length) {
    return { count: 0, min: null, max: null, mean: null, median: null, stddev: null, range: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  const median = sorted[Math.floor(sorted.length / 2)]
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    stddev: Math.sqrt(variance),
    range: sorted[sorted.length - 1] - sorted[0]
  }
}

const round3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(3)))

// ---- 主流程 ----

const main = async () => {
  const gridSnapshot = await readJson('resources/rkbRekordboxAbcGridSnapshot.json')
  const waveformOnsets = await readJson('resources/rkbRekordboxAbcWaveformVisibleOnsets.json')
  const audioDir = resolveAudioDir()

  const gridByFileName = new Map()
  for (const t of gridSnapshot?.tracks || []) {
    gridByFileName.set(String(t.fileName), t)
  }
  const onsetByFileName = new Map()
  for (const t of waveformOnsets?.tracks || []) {
    onsetByFileName.set(String(t.fileName), t)
  }

  const allMode = isAllMode()
  const targetFileNames = allMode
    ? Array.from(gridByFileName.keys())
    : REPRESENTATIVE_FILE_NAMES
  console.log(
    `mode=${allMode ? 'ALL' : 'REPRESENTATIVE'}  trackCount=${targetFileNames.length}`
  )

  const outPerFile = []

  for (const fileName of targetFileNames) {
    const grid = gridByFileName.get(fileName)
    const onset = onsetByFileName.get(fileName)
    if (!grid) {
      console.warn(`[skip] grid snapshot missing for: ${fileName}`)
      continue
    }
    if (!onset) {
      console.warn(`[skip] waveform onset snapshot missing for: ${fileName}`)
      continue
    }
    const filePath = path.join(audioDir, fileName)
    try {
      await fs.access(filePath)
    } catch {
      console.warn(`[skip] audio file not found: ${filePath}`)
      continue
    }

    console.log(`\n=== ${fileName} ===`)
    console.log(`  Rekordbox bpm=${grid.bpm}, firstBeatMs=${grid.firstBeatMs}, barBeatOffset=${grid.barBeatOffset}`)
    console.log(`  Rekordbox waveformVisibleOnsetMs=${onset.waveformVisibleOnsetMs}`)

    const startTimeMs = await probeStartTimeMs(filePath)
    console.log(`  ffprobe start_time_ms=${startTimeMs}`)

    const mp3Class = await classifyMp3File(filePath)
    console.log(
      `  mp3 case=${mp3Class.case}  rekordbox_correction=${mp3Class.correctionMs}ms  reason=${mp3Class.reason}` +
        (mp3Class.lame
          ? `  encoder=${mp3Class.lame.encoderMagic}  crc=${mp3Class.lame.crcOk ? 'ok' : 'bad'}  encDelay=${mp3Class.lame.encoderDelaySamples}smp  encPadding=${mp3Class.lame.encoderPaddingSamples}smp`
          : '')
    )

    const pcm = await decodeMonoFloat32(filePath)
    const { envelope, windowSamples } = buildEnergyEnvelope(pcm)
    console.log(`  decoded: ${(pcm.length / SAMPLE_RATE).toFixed(2)}s PCM, envelope steps=${envelope.length}`)

    // 构造 trim 后的 PCM：从 encoderDelay + 529 样本之后开始，
    // 模拟 Rekordbox / iTunes 这类"gapless"解码器实际播放的零起点。
    const trimSamples =
      (mp3Class.lame?.encoderDelaySamples ?? 0) + MP3_DECODER_DELAY_SAMPLES
    const trimMs = (trimSamples / SAMPLE_RATE) * 1000
    const pcmTrimmed = pcm.subarray(Math.min(trimSamples, pcm.length))
    const { envelope: envelopeTrimmed, windowSamples: windowSamplesTrimmed } =
      buildEnergyEnvelope(pcmTrimmed)
    console.log(
      `  trim: ${trimSamples} samples (${round3(trimMs)} ms) -> trimmed envelope steps=${envelopeTrimmed.length}`
    )

    // 通用 delta 测量函数：在指定 envelope 上跑一次 visibleOnset / firstBeat / grid。
    const runMeasurements = (env, winSamples) => {
      const visible = findLocalEnergyPeakMs(env, winSamples, onset.waveformVisibleOnsetMs)
      const first = findLocalEnergyPeakMs(env, winSamples, grid.firstBeatMs)
      const beatSec = 60 / Number(grid.bpm)
      const beatDeltasLocal = []
      const beatDetailsLocal = []
      for (let i = 0; i < GRID_BEAT_COUNT; i += 1) {
        const beatMs = grid.firstBeatMs + i * beatSec * 1000
        if (beatMs > DECODE_SECONDS * 1000 - SEARCH_RADIUS_MS) break
        const peak = findLocalEnergyPeakMs(env, winSamples, beatMs)
        if (!peak) continue
        const d = peak.peakMs - beatMs
        beatDeltasLocal.push(d)
        beatDetailsLocal.push({
          beatIndex: i,
          referenceMs: round3(beatMs),
          peakMs: round3(peak.peakMs),
          deltaMs: round3(d),
          peakEnergy: peak.peakEnergy
        })
      }
      return {
        visible,
        visibleDelta: visible ? visible.peakMs - onset.waveformVisibleOnsetMs : null,
        first,
        firstDelta: first ? first.peakMs - grid.firstBeatMs : null,
        beatStats: summarize(beatDeltasLocal),
        beatDetails: beatDetailsLocal
      }
    }

    // ---- 在原始 PCM 上测量 ----
    const raw = runMeasurements(envelope, windowSamples)
    // 应用 26ms 修正后的 delta：如果 Rekordbox 跳了一帧（case B/C），那 FRKB 这边
    // 也应当扣掉同样一帧；扣掉之后两边在同一时间基准上比较。
    const rawVisibleCorrected =
      raw.visibleDelta === null ? null : raw.visibleDelta - mp3Class.correctionMs
    const rawFirstCorrected =
      raw.firstDelta === null ? null : raw.firstDelta - mp3Class.correctionMs

    // ---- 在 trim 后的 PCM 上测量（priming-samples 修正）----
    const trimmed = runMeasurements(envelopeTrimmed, windowSamplesTrimmed)

    console.log(
      `  [raw onset]     delta=${round3(raw.visibleDelta)} ms  -> 26ms-corr=${round3(rawVisibleCorrected)} ms`
    )
    console.log(
      `  [raw firstBeat] delta=${round3(raw.firstDelta)} ms  -> 26ms-corr=${round3(rawFirstCorrected)} ms`
    )
    console.log(
      `  [raw grid-${raw.beatStats.count}]   min=${round3(raw.beatStats.min)}  median=${round3(raw.beatStats.median)}  range=${round3(raw.beatStats.range)}`
    )
    console.log(
      `  [trim onset]     delta=${round3(trimmed.visibleDelta)} ms`
    )
    console.log(
      `  [trim firstBeat] delta=${round3(trimmed.firstDelta)} ms`
    )
    console.log(
      `  [trim grid-${trimmed.beatStats.count}]  min=${round3(trimmed.beatStats.min)}  median=${round3(trimmed.beatStats.median)}  range=${round3(trimmed.beatStats.range)}`
    )

    outPerFile.push({
      fileName,
      rekordbox: {
        bpm: grid.bpm,
        firstBeatMs: grid.firstBeatMs,
        barBeatOffset: grid.barBeatOffset,
        waveformVisibleOnsetMs: onset.waveformVisibleOnsetMs
      },
      ffprobe: {
        startTimeMs
      },
      mp3Header: {
        case: mp3Class.case,
        rekordboxCorrectionMs: mp3Class.correctionMs,
        reason: mp3Class.reason,
        encoderMagic: mp3Class.lame?.encoderMagic ?? null,
        crcOk: mp3Class.lame?.crcOk ?? null,
        encoderDelaySamples: mp3Class.lame?.encoderDelaySamples ?? null,
        encoderPaddingSamples: mp3Class.lame?.encoderPaddingSamples ?? null
      },
      measurements: {
        searchRadiusMs: SEARCH_RADIUS_MS,
        energyWindowMs: ENERGY_WINDOW_MS,
        sampleRate: SAMPLE_RATE,
        trimSamples,
        trimMs: round3(trimMs),
        raw: {
          visibleOnset: raw.visible
            ? {
                peakMs: round3(raw.visible.peakMs),
                deltaMs: round3(raw.visibleDelta),
                corrected26msDeltaMs: round3(rawVisibleCorrected),
                peakEnergy: raw.visible.peakEnergy
              }
            : null,
          firstBeat: raw.first
            ? {
                peakMs: round3(raw.first.peakMs),
                deltaMs: round3(raw.firstDelta),
                corrected26msDeltaMs: round3(rawFirstCorrected),
                peakEnergy: raw.first.peakEnergy
              }
            : null,
          gridBeats: {
            stats: {
              count: raw.beatStats.count,
              min: round3(raw.beatStats.min),
              max: round3(raw.beatStats.max),
              mean: round3(raw.beatStats.mean),
              median: round3(raw.beatStats.median),
              stddev: round3(raw.beatStats.stddev),
              range: round3(raw.beatStats.range)
            },
            details: raw.beatDetails
          }
        },
        trimmed: {
          visibleOnset: trimmed.visible
            ? {
                peakMs: round3(trimmed.visible.peakMs),
                deltaMs: round3(trimmed.visibleDelta),
                peakEnergy: trimmed.visible.peakEnergy
              }
            : null,
          firstBeat: trimmed.first
            ? {
                peakMs: round3(trimmed.first.peakMs),
                deltaMs: round3(trimmed.firstDelta),
                peakEnergy: trimmed.first.peakEnergy
              }
            : null,
          gridBeats: {
            stats: {
              count: trimmed.beatStats.count,
              min: round3(trimmed.beatStats.min),
              max: round3(trimmed.beatStats.max),
              mean: round3(trimmed.beatStats.mean),
              median: round3(trimmed.beatStats.median),
              stddev: round3(trimmed.beatStats.stddev),
              range: round3(trimmed.beatStats.range)
            },
            details: trimmed.beatDetails
          }
        }
      }
    })
  }

  // ---- 跨曲比较 ----
  console.log('\n=== cross-track summary ===')
  console.log(
    '| file | case | encDelay | trim_ms | raw.visible | raw.firstBeat | raw.grid.range | trim.visible | trim.firstBeat | trim.grid.range |'
  )
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const item of outPerFile) {
    const shortName = item.fileName.length > 40 ? item.fileName.slice(0, 37) + '...' : item.fileName
    console.log(
      `| ${shortName} | ${item.mp3Header.case} | ${item.mp3Header.encoderDelaySamples ?? '?'} | ${
        item.measurements.trimMs ?? '?'
      } | ${item.measurements.raw.visibleOnset?.deltaMs ?? '?'} | ${
        item.measurements.raw.firstBeat?.deltaMs ?? '?'
      } | ${item.measurements.raw.gridBeats.stats.range ?? '?'} | ${
        item.measurements.trimmed.visibleOnset?.deltaMs ?? '?'
      } | ${item.measurements.trimmed.firstBeat?.deltaMs ?? '?'} | ${
        item.measurements.trimmed.gridBeats.stats.range ?? '?'
      } |`
    )
  }

  // ---- 按 encoder 分组的二分检验 ----
  // 主要观察：raw.firstBeat.delta vs trim.firstBeat.delta，谁更接近 0。
  // 假设：原生 LAME 编码的文件 trim 后更对，Lavc/Lavf 文件不 trim 反而更对。
  console.log('\n=== group by encoder ===')
  const groups = new Map()
  for (const item of outPerFile) {
    const key = String(item.mp3Header.encoderMagic || item.mp3Header.case)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  console.log('| encoder | count | raw.firstBeat |abs| median | trim.firstBeat |abs| median | which is closer to 0 |')
  console.log('|---|---:|---:|---:|---|')
  const absMedian = (xs) => {
    if (!xs.length) return null
    const ys = [...xs].sort((a, b) => a - b)
    return Number(ys[Math.floor(ys.length / 2)].toFixed(3))
  }
  for (const [encoder, items] of groups) {
    const rawAbs = items
      .map((it) => Math.abs(it.measurements.raw.firstBeat?.deltaMs ?? NaN))
      .filter((v) => Number.isFinite(v))
    const trimAbs = items
      .map((it) => Math.abs(it.measurements.trimmed.firstBeat?.deltaMs ?? NaN))
      .filter((v) => Number.isFinite(v))
    const rawMed = absMedian(rawAbs)
    const trimMed = absMedian(trimAbs)
    const verdict =
      rawMed === null || trimMed === null
        ? '?'
        : trimMed < rawMed
          ? 'TRIM 更对'
          : trimMed > rawMed
            ? 'RAW 更对（不该 trim）'
            : 'tied'
    console.log(`| ${encoder} | ${items.length} | ${rawMed} | ${trimMed} | ${verdict} |`)
  }

  // 进一步：每首歌单独的 verdict（绝对值对比）
  console.log('\n=== per-track verdict ===')
  console.log('| file | encoder | raw.firstBeat | trim.firstBeat | verdict |')
  console.log('|---|---|---:|---:|---|')
  for (const item of outPerFile) {
    const raw = item.measurements.raw.firstBeat?.deltaMs
    const trim = item.measurements.trimmed.firstBeat?.deltaMs
    const verdict =
      raw === null || raw === undefined || trim === null || trim === undefined
        ? '?'
        : Math.abs(trim) < Math.abs(raw)
          ? 'TRIM'
          : 'RAW'
    const shortName = item.fileName.length > 50 ? item.fileName.slice(0, 47) + '...' : item.fileName
    console.log(
      `| ${shortName} | ${item.mp3Header.encoderMagic || item.mp3Header.case} | ${raw ?? '?'} | ${trim ?? '?'} | ${verdict} |`
    )
  }

  const outPath = path.resolve(__dirname, 'rekordbox-native-rkb-offline-delta-probe.out.json')
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        decodeSeconds: DECODE_SECONDS,
        sampleRate: SAMPLE_RATE,
        energyWindowMs: ENERGY_WINDOW_MS,
        searchRadiusMs: SEARCH_RADIUS_MS,
        gridBeatCount: GRID_BEAT_COUNT,
        audioDir,
        tracks: outPerFile
      },
      null,
      2
    )
  )
  console.log(`\nwrote: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
