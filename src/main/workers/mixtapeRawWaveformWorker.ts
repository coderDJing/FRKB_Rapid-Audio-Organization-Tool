import { parentPort } from 'node:worker_threads'
import childProcess from 'node:child_process'
import path from 'node:path'

type MixtapeRawWaveformJob = {
  jobId: number
  filePath: string
  targetRate: number
  streamChunks?: boolean
  chunkFrames?: number
  expectedDurationSec?: number
}

type RawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
}

type MixtapeRawWaveformResult = {
  rawWaveformData?: RawWaveformData | null
}

type MixtapeRawWaveformProgressPayload = {
  type: 'chunk'
  startFrame: number
  frames: number
  totalFrames: number
  duration: number
  sampleRate: number
  rate: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
}

type MixtapeRawWaveformResponse = {
  jobId: number
  filePath: string
  progress?: MixtapeRawWaveformProgressPayload
  result?: MixtapeRawWaveformResult
  error?: string
}

const loadRust = () => {
  const binding = require('rust_package') as {
    decodeAudioFile: (filePath: string) => {
      pcmData: Buffer
      sampleRate: number
      channels: number
      totalFrames: number
      error?: string
    }
  }
  return binding
}

const STREAM_SAMPLE_RATE = 44100
const STREAM_CHANNELS = 2

const toFloat32ArrayFromBuffer = (input: Buffer): Float32Array => {
  if (!input || input.length < 4) return new Float32Array(0)
  const byteOffsetAligned = input.byteOffset % 4 === 0
  const byteLengthAligned = input.byteLength % 4 === 0
  if (byteOffsetAligned && byteLengthAligned) {
    return new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4)
  }
  const usableBytes = input.byteLength - (input.byteLength % 4)
  if (usableBytes <= 0) return new Float32Array(0)
  const copied = new Uint8Array(usableBytes)
  copied.set(input.subarray(0, usableBytes))
  return new Float32Array(copied.buffer)
}

const resolveBundledFfmpegPath = () => {
  const envPath = String(process.env.FRKB_FFMPEG_PATH || '').trim()
  if (!envPath) {
    throw new Error('FRKB_FFMPEG_PATH not configured')
  }
  return envPath
}

const createRawWaveformAccumulator = (params: {
  sampleRate: number
  channels: number
  targetRate: number
  expectedDurationSec?: number
  streamChunks?: boolean
  chunkFrames?: number
  onChunk?: (payload: MixtapeRawWaveformProgressPayload) => void
}) => {
  const sampleRate = Math.max(1, params.sampleRate)
  const channels = Math.max(1, params.channels)
  const rate = Math.max(1, Math.min(Number(params.targetRate) || 1, sampleRate || 1))
  const step = sampleRate / rate
  const estimatedFrames = Math.max(
    1,
    Math.floor(Math.max(0, Number(params.expectedDurationSec) || 0) * rate) + 1
  )
  const targetDurationSec =
    Number.isFinite(Number(params.expectedDurationSec)) && Number(params.expectedDurationSec) > 0
      ? Number(params.expectedDurationSec)
      : 0
  const shouldStream = params.streamChunks === true && typeof params.onChunk === 'function'
  const streamChunkFrames = shouldStream
    ? Math.max(1024, Math.floor(Number(params.chunkFrames) || 16384))
    : 0

  let minLeftValues = new Float32Array(estimatedFrames)
  let maxLeftValues = new Float32Array(estimatedFrames)
  let minRightValues = new Float32Array(estimatedFrames)
  let maxRightValues = new Float32Array(estimatedFrames)
  let outIndex = 0
  let position = 0
  let nextStore = step
  let currentMinLeft = 1
  let currentMaxLeft = -1
  let currentMinRight = 1
  let currentMaxRight = -1
  let nextChunkStartFrame = 0
  let totalInputFrames = 0

  const ensureCapacity = (requiredFrames: number) => {
    if (requiredFrames <= minLeftValues.length) return
    const nextLength = Math.max(requiredFrames, minLeftValues.length * 2)
    const grow = (source: Float32Array) => {
      const next = new Float32Array(nextLength)
      next.set(source)
      return next
    }
    minLeftValues = grow(minLeftValues)
    maxLeftValues = grow(maxLeftValues)
    minRightValues = grow(minRightValues)
    maxRightValues = grow(maxRightValues)
  }

  const emitChunk = (endExclusiveFrame: number) => {
    if (!shouldStream || endExclusiveFrame <= nextChunkStartFrame) return
    const frames = endExclusiveFrame - nextChunkStartFrame
    params.onChunk?.({
      type: 'chunk',
      startFrame: nextChunkStartFrame,
      frames,
      totalFrames:
        targetDurationSec > 0
          ? estimatedFrames
          : Math.max(endExclusiveFrame, Math.floor(totalInputFrames / step) + 1),
      duration:
        targetDurationSec > 0
          ? targetDurationSec
          : sampleRate > 0
            ? totalInputFrames / sampleRate
            : 0,
      sampleRate,
      rate,
      minLeft: Buffer.from(
        minLeftValues.buffer,
        minLeftValues.byteOffset + nextChunkStartFrame * 4,
        frames * 4
      ),
      maxLeft: Buffer.from(
        maxLeftValues.buffer,
        maxLeftValues.byteOffset + nextChunkStartFrame * 4,
        frames * 4
      ),
      minRight: Buffer.from(
        minRightValues.buffer,
        minRightValues.byteOffset + nextChunkStartFrame * 4,
        frames * 4
      ),
      maxRight: Buffer.from(
        maxRightValues.buffer,
        maxRightValues.byteOffset + nextChunkStartFrame * 4,
        frames * 4
      )
    })
    nextChunkStartFrame = endExclusiveFrame
  }

  const appendSamples = (pcmChunk: Float32Array) => {
    const totalSamples = pcmChunk.length - (pcmChunk.length % channels)
    for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += channels) {
      const leftSample = pcmChunk[sampleIndex] || 0
      const rightSample = channels > 1 ? pcmChunk[sampleIndex + 1] || 0 : leftSample
      if (leftSample < currentMinLeft) currentMinLeft = leftSample
      if (leftSample > currentMaxLeft) currentMaxLeft = leftSample
      if (rightSample < currentMinRight) currentMinRight = rightSample
      if (rightSample > currentMaxRight) currentMaxRight = rightSample
      position += 1
      totalInputFrames += 1
      if (position >= nextStore) {
        ensureCapacity(outIndex + 1)
        minLeftValues[outIndex] = currentMinLeft
        maxLeftValues[outIndex] = currentMaxLeft
        minRightValues[outIndex] = currentMinRight
        maxRightValues[outIndex] = currentMaxRight
        outIndex += 1
        currentMinLeft = 1
        currentMaxLeft = -1
        currentMinRight = 1
        currentMaxRight = -1
        nextStore += step
        if (shouldStream && outIndex - nextChunkStartFrame >= streamChunkFrames) {
          emitChunk(outIndex)
        }
      }
    }
  }

  const finalize = (): RawWaveformData => {
    ensureCapacity(outIndex + 1)
    if (
      currentMinLeft !== 1 ||
      currentMaxLeft !== -1 ||
      currentMinRight !== 1 ||
      currentMaxRight !== -1
    ) {
      minLeftValues[outIndex] = currentMinLeft === 1 ? 0 : currentMinLeft
      maxLeftValues[outIndex] = currentMaxLeft === -1 ? 0 : currentMaxLeft
      minRightValues[outIndex] = currentMinRight === 1 ? 0 : currentMinRight
      maxRightValues[outIndex] = currentMaxRight === -1 ? 0 : currentMaxRight
      outIndex += 1
    }
    if (shouldStream) {
      emitChunk(outIndex)
    }

    const finalMinLeft = minLeftValues.subarray(0, outIndex)
    const finalMaxLeft = maxLeftValues.subarray(0, outIndex)
    const finalMinRight = minRightValues.subarray(0, outIndex)
    const finalMaxRight = maxRightValues.subarray(0, outIndex)

    return {
      duration: sampleRate > 0 ? totalInputFrames / sampleRate : 0,
      sampleRate,
      rate,
      frames: outIndex,
      minLeft: Buffer.from(finalMinLeft.buffer, finalMinLeft.byteOffset, finalMinLeft.byteLength),
      maxLeft: Buffer.from(finalMaxLeft.buffer, finalMaxLeft.byteOffset, finalMaxLeft.byteLength),
      minRight: Buffer.from(
        finalMinRight.buffer,
        finalMinRight.byteOffset,
        finalMinRight.byteLength
      ),
      maxRight: Buffer.from(
        finalMaxRight.buffer,
        finalMaxRight.byteOffset,
        finalMaxRight.byteLength
      )
    }
  }

  return {
    appendSamples,
    finalize
  }
}

const computeRawWaveform = (
  pcmData: Buffer,
  sampleRate: number,
  channels: number,
  targetRate: number,
  options: {
    streamChunks?: boolean
    chunkFrames?: number
    onChunk?: (payload: MixtapeRawWaveformProgressPayload) => void
  } = {}
): RawWaveformData => {
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const totalFrames = Math.floor(totalSamples / Math.max(1, channels))
  const rate = Math.max(1, Math.min(Number(targetRate) || 1, sampleRate || 1))
  const step = sampleRate / rate
  const expectedFrames = Math.floor(totalFrames / step) + 1

  const minLeftValues = new Float32Array(expectedFrames)
  const maxLeftValues = new Float32Array(expectedFrames)
  const minRightValues = new Float32Array(expectedFrames)
  const maxRightValues = new Float32Array(expectedFrames)

  let outIndex = 0
  let position = 0
  let nextStore = step
  let currentMinLeft = 1
  let currentMaxLeft = -1
  let currentMinRight = 1
  let currentMaxRight = -1

  const pcm = new Float32Array(pcmData.buffer, pcmData.byteOffset, totalSamples)
  const channelCount = Math.max(1, channels)
  const shouldStream = options.streamChunks === true && typeof options.onChunk === 'function'
  const streamChunkFrames = shouldStream
    ? Math.max(256, Math.floor(Number(options.chunkFrames) || 2048))
    : 0
  let nextChunkStartFrame = 0

  const emitChunk = (endExclusiveFrame: number) => {
    if (!shouldStream || endExclusiveFrame <= nextChunkStartFrame) return
    const frames = endExclusiveFrame - nextChunkStartFrame
    const minLeftChunk = minLeftValues.subarray(nextChunkStartFrame, endExclusiveFrame)
    const maxLeftChunk = maxLeftValues.subarray(nextChunkStartFrame, endExclusiveFrame)
    const minRightChunk = minRightValues.subarray(nextChunkStartFrame, endExclusiveFrame)
    const maxRightChunk = maxRightValues.subarray(nextChunkStartFrame, endExclusiveFrame)
    options.onChunk?.({
      type: 'chunk',
      startFrame: nextChunkStartFrame,
      frames,
      totalFrames: expectedFrames,
      duration: sampleRate > 0 ? totalFrames / sampleRate : 0,
      sampleRate,
      rate,
      minLeft: Buffer.from(minLeftChunk.buffer, minLeftChunk.byteOffset, minLeftChunk.byteLength),
      maxLeft: Buffer.from(maxLeftChunk.buffer, maxLeftChunk.byteOffset, maxLeftChunk.byteLength),
      minRight: Buffer.from(
        minRightChunk.buffer,
        minRightChunk.byteOffset,
        minRightChunk.byteLength
      ),
      maxRight: Buffer.from(
        maxRightChunk.buffer,
        maxRightChunk.byteOffset,
        maxRightChunk.byteLength
      )
    })
    nextChunkStartFrame = endExclusiveFrame
  }

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const base = frame * channelCount
    const leftSample = pcm[base] || 0
    const rightSample = channelCount > 1 ? pcm[base + 1] || 0 : leftSample
    if (leftSample < currentMinLeft) currentMinLeft = leftSample
    if (leftSample > currentMaxLeft) currentMaxLeft = leftSample
    if (rightSample < currentMinRight) currentMinRight = rightSample
    if (rightSample > currentMaxRight) currentMaxRight = rightSample
    position += 1
    if (position >= nextStore) {
      minLeftValues[outIndex] = currentMinLeft
      maxLeftValues[outIndex] = currentMaxLeft
      minRightValues[outIndex] = currentMinRight
      maxRightValues[outIndex] = currentMaxRight
      outIndex += 1
      currentMinLeft = 1
      currentMaxLeft = -1
      currentMinRight = 1
      currentMaxRight = -1
      nextStore += step
      if (shouldStream && outIndex - nextChunkStartFrame >= streamChunkFrames) {
        emitChunk(outIndex)
      }
      if (outIndex >= expectedFrames) break
    }
  }

  if (outIndex < expectedFrames) {
    for (let i = outIndex; i < expectedFrames; i += 1) {
      minLeftValues[i] = currentMinLeft === 1 ? 0 : currentMinLeft
      maxLeftValues[i] = currentMaxLeft === -1 ? 0 : currentMaxLeft
      minRightValues[i] = currentMinRight === 1 ? 0 : currentMinRight
      maxRightValues[i] = currentMaxRight === -1 ? 0 : currentMaxRight
    }
  }

  if (shouldStream) {
    emitChunk(expectedFrames)
  }

  return {
    duration: sampleRate > 0 ? totalFrames / sampleRate : 0,
    sampleRate,
    rate,
    frames: expectedFrames,
    minLeft: Buffer.from(minLeftValues.buffer, minLeftValues.byteOffset, minLeftValues.byteLength),
    maxLeft: Buffer.from(maxLeftValues.buffer, maxLeftValues.byteOffset, maxLeftValues.byteLength),
    minRight: Buffer.from(
      minRightValues.buffer,
      minRightValues.byteOffset,
      minRightValues.byteLength
    ),
    maxRight: Buffer.from(
      maxRightValues.buffer,
      maxRightValues.byteOffset,
      maxRightValues.byteLength
    )
  }
}

const buildRawWaveform = (filePath: string, targetRate: number): MixtapeRawWaveformResult => {
  const rust = loadRust()
  const decoded = rust.decodeAudioFile(filePath)
  if (decoded.error) {
    throw new Error(decoded.error)
  }
  const rawWaveformData = computeRawWaveform(
    decoded.pcmData,
    decoded.sampleRate,
    decoded.channels,
    targetRate,
    {
      streamChunks: false
    }
  )
  return { rawWaveformData }
}

const buildRawWaveformStreamed = async (
  filePath: string,
  targetRate: number,
  options: {
    expectedDurationSec?: number
    chunkFrames?: number
    onChunk?: (payload: MixtapeRawWaveformProgressPayload) => void
  }
) => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const args = [
    '-v',
    'error',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    String(STREAM_CHANNELS),
    '-ar',
    String(STREAM_SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1'
  ]

  const accumulator = createRawWaveformAccumulator({
    sampleRate: STREAM_SAMPLE_RATE,
    channels: STREAM_CHANNELS,
    targetRate,
    expectedDurationSec: options.expectedDurationSec,
    streamChunks: true,
    chunkFrames: options.chunkFrames,
    onChunk: options.onChunk
  })

  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let remainder = Buffer.alloc(0)
    let stderrText = ''

    child.stdout.on('data', (chunk: Buffer) => {
      const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk
      const frameByteSize = STREAM_CHANNELS * 4
      const usableBytes = combined.length - (combined.length % frameByteSize)
      if (usableBytes <= 0) {
        remainder = combined
        return
      }
      const usableChunk =
        usableBytes === combined.length ? combined : combined.subarray(0, usableBytes)
      remainder = usableBytes === combined.length ? Buffer.alloc(0) : combined.subarray(usableBytes)
      accumulator.appendSamples(toFloat32ArrayFromBuffer(usableChunk))
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString()
    })

    child.once('error', (error) => {
      reject(error)
    })

    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderrText.trim() || `ffmpeg exited with code ${code}`))
    })
  })

  return { rawWaveformData: accumulator.finalize() }
}

parentPort?.on('message', async (job: MixtapeRawWaveformJob) => {
  const response: MixtapeRawWaveformResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    if (job.streamChunks) {
      response.result = await buildRawWaveformStreamed(job.filePath, job.targetRate, {
        expectedDurationSec: Number(job.expectedDurationSec) || 0,
        chunkFrames: job.chunkFrames,
        onChunk: (progress) => {
          parentPort?.postMessage({
            jobId: response.jobId,
            filePath: response.filePath,
            progress
          } satisfies MixtapeRawWaveformResponse)
        }
      })
    } else {
      response.result = buildRawWaveform(job.filePath, job.targetRate)
    }
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
