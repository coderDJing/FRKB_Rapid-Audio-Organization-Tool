const WORKLET_NAME = 'mixtape-beat-align-scrub'
const MAX_ABS_RATE = 12
const RATE_SMOOTH = 0.2
const IDLE_RATE_SMOOTH = 0.35
const INPUT_IDLE_TIMEOUT_SEC = 0.038
const RATE_EPSILON = 0.0001
const TARGET_P_GAIN = 0.00055
const MAX_TARGET_COMPENSATE = 10
const POSITION_REPORT_INTERVAL = 2048

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const cubicHermite = (frac, xm1, x0, x1, x2) => {
  const c = (x1 - xm1) * 0.5
  const v = x0 - x1
  const w = c + v
  const a = w + v + (x2 - x0) * 0.5
  const bNeg = w + a
  return ((a * frac - bNeg) * frac + c) * frac + x0
}

class MixtapeBeatAlignScrubProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sourceChannels = []
    this.frameCount = 0
    this.sourceSampleRate = sampleRate
    this.sourceToOutputRate = 1
    this.playhead = 0
    this.targetFrame = 0
    this.targetRate = 0
    this.smoothedRate = 0
    this.active = false
    this.reportCounter = 0
    this.secondsSinceLastTarget = 0

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'set-source') {
        const channels = Array.isArray(data.channels) ? data.channels : []
        this.sourceChannels = channels.filter((item) => item instanceof Float32Array)
        this.frameCount = Math.max(0, Number(data.frameCount) || 0)
        this.sourceSampleRate = Math.max(1, Number(data.sampleRate) || sampleRate)
        this.sourceToOutputRate = this.sourceSampleRate / Math.max(1, sampleRate)
        const startFrame = clamp(Number(data.startFrame) || 0, 0, Math.max(0, this.frameCount - 1))
        this.playhead = startFrame
        this.targetFrame = startFrame
        this.targetRate = 0
        this.smoothedRate = 0
        this.reportCounter = 0
        this.secondsSinceLastTarget = 0
        this.active = this.sourceChannels.length > 0 && this.frameCount > 1
      } else if (data.type === 'set-target') {
        if (!this.active) return
        const maxFrame = Math.max(0, this.frameCount - 1)
        this.targetFrame = clamp(Number(data.targetFrame) || 0, 0, maxFrame)
        const rate = clamp(Number(data.targetRate) || 0, -MAX_ABS_RATE, MAX_ABS_RATE)
        this.targetRate = Number.isFinite(rate) ? rate : 0
        this.secondsSinceLastTarget = 0
      } else if (data.type === 'stop') {
        this.active = false
        this.targetRate = 0
        this.secondsSinceLastTarget = 0
      }
    }
  }

  sampleAt(channelData, frame) {
    const maxFrame = this.frameCount - 1
    const readFrame = clamp(frame, 0, Math.max(0, maxFrame))
    if (this.frameCount < 4) {
      const baseIndex = Math.floor(readFrame)
      const nextIndex = Math.min(maxFrame, baseIndex + 1)
      const frac = readFrame - baseIndex
      const a = channelData[baseIndex] || 0
      const b = channelData[nextIndex] || 0
      return a + (b - a) * frac
    }
    const baseIndex = Math.floor(readFrame)
    const frac = readFrame - baseIndex
    const xm1Index = Math.max(0, baseIndex - 1)
    const x0Index = clamp(baseIndex, 0, maxFrame)
    const x1Index = clamp(baseIndex + 1, 0, maxFrame)
    const x2Index = clamp(baseIndex + 2, 0, maxFrame)
    return cubicHermite(
      frac,
      channelData[xm1Index] || 0,
      channelData[x0Index] || 0,
      channelData[x1Index] || 0,
      channelData[x2Index] || 0
    )
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outputFrames = output[0]?.length || 0
    if (
      !this.active ||
      this.sourceChannels.length === 0 ||
      this.frameCount <= 1 ||
      outputFrames <= 0
    ) {
      for (let ch = 0; ch < output.length; ch += 1) {
        output[ch].fill(0)
      }
      return true
    }

    const maxFrame = this.frameCount - 1
    this.secondsSinceLastTarget += outputFrames / Math.max(1, sampleRate)
    const inputIdle = this.secondsSinceLastTarget >= INPUT_IDLE_TIMEOUT_SEC
    const targetRate = inputIdle ? 0 : this.targetRate
    const rateSmooth = inputIdle ? IDLE_RATE_SMOOTH : RATE_SMOOTH
    for (let i = 0; i < outputFrames; i += 1) {
      this.smoothedRate += (targetRate - this.smoothedRate) * rateSmooth
      if (Math.abs(this.smoothedRate) < RATE_EPSILON) {
        this.smoothedRate = 0
      }
      const positionError = inputIdle ? 0 : this.targetFrame - this.playhead
      const compensateRate = clamp(
        positionError * TARGET_P_GAIN,
        -MAX_TARGET_COMPENSATE,
        MAX_TARGET_COMPENSATE
      )
      const effectiveRate = this.smoothedRate + compensateRate
      const step = effectiveRate * this.sourceToOutputRate

      const readFrame = clamp(this.playhead, 0, maxFrame)
      for (let ch = 0; ch < output.length; ch += 1) {
        const sourceIndex = Math.min(this.sourceChannels.length - 1, ch)
        const channelData = this.sourceChannels[Math.max(0, sourceIndex)]
        output[ch][i] = this.sampleAt(channelData, readFrame)
      }

      this.playhead += step
      if (this.playhead <= 0) {
        this.playhead = 0
        if (step < 0) this.smoothedRate *= 0.75
      } else if (this.playhead >= maxFrame) {
        this.playhead = maxFrame
        if (step > 0) this.smoothedRate *= 0.75
      }
    }

    this.reportCounter += outputFrames
    if (this.reportCounter >= POSITION_REPORT_INTERVAL) {
      this.reportCounter = 0
      this.port.postMessage({
        type: 'position',
        frame: this.playhead
      })
    }
    return true
  }
}

registerProcessor(WORKLET_NAME, MixtapeBeatAlignScrubProcessor)
