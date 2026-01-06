import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MIXXX_WAVEFORM_CACHE_VERSION = 1
const MIXXX_WAVEFORM_CACHE_DIR = 'mixxx-waveform-v1'
const MIXXX_WAVEFORM_BANDS = ['low', 'mid', 'high'] as const

export type MixxxWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft: Uint8Array
  peakRight: Uint8Array
}

export type MixxxWaveformData = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<(typeof MIXXX_WAVEFORM_BANDS)[number], MixxxWaveformBand>
}

type MixxxWaveformCacheMeta = {
  version: number
  fileSize: number
  mtimeMs: number
  sampleRate: number
  step: number
  duration: number
  frames: number
}

const buildCachePaths = (cacheRoot: string, filePath: string) => {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex')
  const dir = path.join(cacheRoot, 'waveforms', MIXXX_WAVEFORM_CACHE_DIR)
  return {
    dir,
    metaPath: path.join(dir, `${hash}.json`),
    dataPath: path.join(dir, `${hash}.bin`)
  }
}

const safeParseMeta = (raw: string): MixxxWaveformCacheMeta | null => {
  try {
    return JSON.parse(raw) as MixxxWaveformCacheMeta
  } catch {
    return null
  }
}

const getExpectedByteLength = (frames: number) => frames * 12

export async function readMixxxWaveformCache(
  cacheRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<MixxxWaveformData | null> {
  if (!cacheRoot) return null
  const { metaPath, dataPath } = buildCachePaths(cacheRoot, filePath)

  let metaRaw: string
  try {
    metaRaw = await fs.readFile(metaPath, 'utf8')
  } catch {
    return null
  }

  const meta = safeParseMeta(metaRaw)
  if (!meta) return null
  if (meta.version !== MIXXX_WAVEFORM_CACHE_VERSION) return null
  if (meta.fileSize !== stat.size) return null
  if (Math.abs(meta.mtimeMs - stat.mtimeMs) > 1) return null
  if (!meta.frames || meta.frames <= 0) return null

  let data: Buffer
  try {
    data = await fs.readFile(dataPath)
  } catch {
    return null
  }

  const expected = getExpectedByteLength(meta.frames)
  if (data.length < expected) return null

  let offset = 0
  const readArray = () => {
    const slice = data.subarray(offset, offset + meta.frames)
    offset += meta.frames
    return slice
  }

  const low = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }
  const mid = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }
  const high = {
    left: readArray(),
    right: readArray(),
    peakLeft: readArray(),
    peakRight: readArray()
  }

  return {
    duration: meta.duration,
    sampleRate: meta.sampleRate,
    step: meta.step,
    bands: { low, mid, high }
  }
}

export async function writeMixxxWaveformCache(
  cacheRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  data: MixxxWaveformData
): Promise<void> {
  if (!cacheRoot) return
  const { dir, metaPath, dataPath } = buildCachePaths(cacheRoot, filePath)
  const low = data.bands.low
  const mid = data.bands.mid
  const high = data.bands.high
  const frames = low.left.length

  if (!frames) return
  if (
    low.right.length !== frames ||
    low.peakLeft.length !== frames ||
    low.peakRight.length !== frames ||
    mid.left.length !== frames ||
    mid.right.length !== frames ||
    mid.peakLeft.length !== frames ||
    mid.peakRight.length !== frames ||
    high.left.length !== frames ||
    high.right.length !== frames ||
    high.peakLeft.length !== frames ||
    high.peakRight.length !== frames
  ) {
    return
  }

  await fs.mkdir(dir, { recursive: true })

  const payload = Buffer.concat([
    Buffer.from(low.left),
    Buffer.from(low.right),
    Buffer.from(low.peakLeft),
    Buffer.from(low.peakRight),
    Buffer.from(mid.left),
    Buffer.from(mid.right),
    Buffer.from(mid.peakLeft),
    Buffer.from(mid.peakRight),
    Buffer.from(high.left),
    Buffer.from(high.right),
    Buffer.from(high.peakLeft),
    Buffer.from(high.peakRight)
  ])

  const meta: MixxxWaveformCacheMeta = {
    version: MIXXX_WAVEFORM_CACHE_VERSION,
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    sampleRate: data.sampleRate,
    step: data.step,
    duration: data.duration,
    frames
  }

  await fs.writeFile(dataPath, payload)
  await fs.writeFile(metaPath, JSON.stringify(meta))
}
