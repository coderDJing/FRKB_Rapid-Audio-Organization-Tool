import { parentPort } from 'node:worker_threads'

type MixtapeRawWaveformJob = {
  jobId: number
  filePath: string
  targetRate: number
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

type MixtapeRawWaveformResponse = {
  jobId: number
  filePath: string
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

const computeRawWaveform = (
  pcmData: Buffer,
  sampleRate: number,
  channels: number,
  targetRate: number
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
    targetRate
  )
  return { rawWaveformData }
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
    response.result = buildRawWaveform(job.filePath, job.targetRate)
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
