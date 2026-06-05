export type RawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
  meanLeft: Buffer
  meanRight: Buffer
  rmsLeft: Buffer
  rmsRight: Buffer
}

export const computeRawWaveform = (
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
  const meanLeftValues = new Float32Array(expectedFrames)
  const meanRightValues = new Float32Array(expectedFrames)
  const rmsLeftValues = new Float32Array(expectedFrames)
  const rmsRightValues = new Float32Array(expectedFrames)

  let outIndex = 0
  let position = 0
  let nextStore = step
  let currentMinLeft = 1
  let currentMaxLeft = -1
  let currentMinRight = 1
  let currentMaxRight = -1
  let currentSumLeft = 0
  let currentSumRight = 0
  let currentSumSqLeft = 0
  let currentSumSqRight = 0
  let currentSampleCount = 0

  const pcm = new Float32Array(pcmData.buffer, pcmData.byteOffset, totalSamples)
  const channelCount = Math.max(1, channels)

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const offset = frame * channelCount
    const leftSample = pcm[offset] ?? 0
    const rightSample = channelCount > 1 ? (pcm[offset + 1] ?? leftSample) : leftSample
    if (leftSample < currentMinLeft) currentMinLeft = leftSample
    if (leftSample > currentMaxLeft) currentMaxLeft = leftSample
    if (rightSample < currentMinRight) currentMinRight = rightSample
    if (rightSample > currentMaxRight) currentMaxRight = rightSample
    currentSumLeft += leftSample
    currentSumRight += rightSample
    currentSumSqLeft += leftSample * leftSample
    currentSumSqRight += rightSample * rightSample
    currentSampleCount += 1
    position += 1
    if (position >= nextStore) {
      minLeftValues[outIndex] = currentMinLeft
      maxLeftValues[outIndex] = currentMaxLeft
      minRightValues[outIndex] = currentMinRight
      maxRightValues[outIndex] = currentMaxRight
      meanLeftValues[outIndex] = currentSampleCount > 0 ? currentSumLeft / currentSampleCount : 0
      meanRightValues[outIndex] = currentSampleCount > 0 ? currentSumRight / currentSampleCount : 0
      rmsLeftValues[outIndex] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqLeft / currentSampleCount) : 0
      rmsRightValues[outIndex] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqRight / currentSampleCount) : 0
      outIndex += 1
      currentMinLeft = 1
      currentMaxLeft = -1
      currentMinRight = 1
      currentMaxRight = -1
      currentSumLeft = 0
      currentSumRight = 0
      currentSumSqLeft = 0
      currentSumSqRight = 0
      currentSampleCount = 0
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
      meanLeftValues[i] = currentSampleCount > 0 ? currentSumLeft / currentSampleCount : 0
      meanRightValues[i] = currentSampleCount > 0 ? currentSumRight / currentSampleCount : 0
      rmsLeftValues[i] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqLeft / currentSampleCount) : 0
      rmsRightValues[i] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqRight / currentSampleCount) : 0
    }
  }

  return {
    duration: totalFrames / Math.max(1, sampleRate),
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
    ),
    meanLeft: Buffer.from(
      meanLeftValues.buffer,
      meanLeftValues.byteOffset,
      meanLeftValues.byteLength
    ),
    meanRight: Buffer.from(
      meanRightValues.buffer,
      meanRightValues.byteOffset,
      meanRightValues.byteLength
    ),
    rmsLeft: Buffer.from(rmsLeftValues.buffer, rmsLeftValues.byteOffset, rmsLeftValues.byteLength),
    rmsRight: Buffer.from(
      rmsRightValues.buffer,
      rmsRightValues.byteOffset,
      rmsRightValues.byteLength
    )
  }
}
