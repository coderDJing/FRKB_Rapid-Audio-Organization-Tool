const WORKLET_NAME = 'mixtape-transport-keylock'
const MIN_RATE = 0.25
const MAX_RATE = 4
const GRAIN_SIZE = 2048
const GRAIN_HOP = 1024
const POSITION_REPORT_INTERVAL = 4096

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const cubicHermite = (frac, xm1, x0, x1, x2) => {
  const c = (x1 - xm1) * 0.5
  const v = x0 - x1
  const w = c + v
  const a = w + v + (x2 - x0) * 0.5
  const bNeg = w + a
  return ((a * frac - bNeg) * frac + c) * frac + x0
}

const hannWindow = (index, size) => {
  if (size <= 1) return 1
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1))
}

class MixtapeTransportKeyLockProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sourceChannels = []
    this.sourceChunks = []
    this.frameCount = 0
    this.sourceSampleRate = sampleRate
    this.sourceToOutputRate = 1
    this.outputChannels = 2
    this.startTimeSec = 0
    this.stopTimeSec = null
    this.started = false
    this.playing = false
    this.endedPosted = false
    this.currentRate = 1
    this.targetRate = 1
    this.rateSmoothFactor = 0.02
    this.nextSourceFrame = 0
    this.framesUntilNextGrain = 0
    this.activeGrains = []
    this.reportCounter = 0

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'set-source') {
        const channels = Array.isArray(data.channels) ? data.channels : []
        this.sourceChannels = channels.filter((item) => item instanceof Float32Array)
        this.sourceChunks = []
        this.frameCount = Math.max(0, Number(data.frameCount) || 0)
        this.sourceSampleRate = Math.max(1, Number(data.sampleRate) || sampleRate)
        this.sourceToOutputRate = this.sourceSampleRate / Math.max(1, sampleRate)
        this.outputChannels = Math.max(
          1,
          Number(data.outputChannels) || this.sourceChannels.length || 2
        )
        this.resetState()
      } else if (data.type === 'set-source-meta') {
        this.sourceChannels = []
        this.sourceChunks = []
        this.frameCount = Math.max(0, Number(data.frameCount) || 0)
        this.sourceSampleRate = Math.max(1, Number(data.sampleRate) || sampleRate)
        this.sourceToOutputRate = this.sourceSampleRate / Math.max(1, sampleRate)
        this.outputChannels = Math.max(1, Number(data.outputChannels) || 2)
        this.resetState()
      } else if (data.type === 'append-chunk') {
        const channels = Array.isArray(data.channels) ? data.channels : []
        const normalizedChannels = channels.filter((item) => item instanceof Float32Array)
        const startFrame = Math.max(0, Math.floor(Number(data.startFrame) || 0))
        const frameCount = Math.max(0, Math.floor(Number(data.frameCount) || 0))
        if (!normalizedChannels.length || frameCount <= 0) return
        const endFrame = startFrame + frameCount
        this.sourceChunks = this.sourceChunks.filter((chunk) => chunk.startFrame !== startFrame)
        this.sourceChunks.push({
          startFrame,
          endFrame,
          channels: normalizedChannels
        })
        this.sourceChunks.sort((a, b) => a.startFrame - b.startFrame)
      } else if (data.type === 'trim-before-frame') {
        const frame = Math.max(0, Math.floor(Number(data.frame) || 0))
        this.sourceChunks = this.sourceChunks.filter((chunk) => chunk.endFrame > frame)
      } else if (data.type === 'dispose') {
        this.sourceChannels = []
        this.sourceChunks = []
        this.frameCount = 0
        this.resetState()
      } else if (data.type === 'start') {
        const startFrame = clamp(Number(data.startFrame) || 0, 0, Math.max(0, this.frameCount - 1))
        this.startTimeSec = Math.max(0, Number(data.startTimeSec) || currentTime)
        this.stopTimeSec = null
        this.currentRate = clamp(Number(data.rate) || 1, MIN_RATE, MAX_RATE)
        this.targetRate = this.currentRate
        this.framesUntilNextGrain = 0
        this.nextSourceFrame = startFrame
        this.activeGrains = []
        this.started = true
        this.playing = true
        this.endedPosted = false
        this.reportCounter = 0
      } else if (data.type === 'set-rate') {
        this.targetRate = clamp(Number(data.rate) || 1, MIN_RATE, MAX_RATE)
        const timeConstant = Math.max(0.0001, Number(data.timeConstant) || 0.04)
        const samples = Math.max(1, Math.round(timeConstant * sampleRate))
        this.rateSmoothFactor = clamp(1 / samples, 0.002, 0.5)
      } else if (data.type === 'stop') {
        const stopTimeSec = Number(data.stopTimeSec)
        this.stopTimeSec =
          Number.isFinite(stopTimeSec) && stopTimeSec > currentTime ? stopTimeSec : currentTime
      }
    }
  }

  resetState() {
    this.startTimeSec = 0
    this.stopTimeSec = null
    this.started = false
    this.playing = false
    this.endedPosted = false
    this.currentRate = 1
    this.targetRate = 1
    this.rateSmoothFactor = 0.02
    this.nextSourceFrame = 0
    this.framesUntilNextGrain = 0
    this.activeGrains = []
    this.reportCounter = 0
  }

  resolveDiscreteSample(channelIndex, frameIndex) {
    const safeFrame = clamp(frameIndex, 0, Math.max(0, this.frameCount - 1))
    if (this.sourceChannels.length > 0) {
      const sourceIndex = Math.min(this.sourceChannels.length - 1, channelIndex)
      const channelData = this.sourceChannels[Math.max(0, sourceIndex)]
      return channelData?.[safeFrame] || 0
    }
    if (!this.sourceChunks.length) return 0
    const sourceIndex = Math.max(0, channelIndex)
    for (let index = 0; index < this.sourceChunks.length; index += 1) {
      const chunk = this.sourceChunks[index]
      if (safeFrame < chunk.startFrame || safeFrame >= chunk.endFrame) continue
      const channelData =
        chunk.channels[Math.min(chunk.channels.length - 1, sourceIndex)] ||
        chunk.channels[Math.max(0, Math.min(chunk.channels.length - 1, 0))]
      if (!channelData) return 0
      return channelData[safeFrame - chunk.startFrame] || 0
    }
    return 0
  }

  sampleAt(channelIndex, frame) {
    const maxFrame = this.frameCount - 1
    const readFrame = clamp(frame, 0, Math.max(0, maxFrame))
    if (this.frameCount < 4) {
      const baseIndex = Math.floor(readFrame)
      const nextIndex = Math.min(maxFrame, baseIndex + 1)
      const frac = readFrame - baseIndex
      const a = this.resolveDiscreteSample(channelIndex, baseIndex)
      const b = this.resolveDiscreteSample(channelIndex, nextIndex)
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
      this.resolveDiscreteSample(channelIndex, xm1Index),
      this.resolveDiscreteSample(channelIndex, x0Index),
      this.resolveDiscreteSample(channelIndex, x1Index),
      this.resolveDiscreteSample(channelIndex, x2Index)
    )
  }

  spawnGrain() {
    if (!this.playing || this.frameCount <= 1) return
    const maxStart = Math.max(0, this.frameCount - GRAIN_SIZE * this.sourceToOutputRate - 2)
    const sourceStartFrame = clamp(this.nextSourceFrame, 0, maxStart)
    this.activeGrains.push({
      sourceStartFrame,
      age: 0
    })
    const safeRate = clamp(this.currentRate, MIN_RATE, MAX_RATE)
    this.nextSourceFrame = sourceStartFrame + GRAIN_HOP * safeRate * this.sourceToOutputRate
    this.framesUntilNextGrain = GRAIN_HOP
  }

  renderSample(channelIndex) {
    if (!this.activeGrains.length) return 0
    let sum = 0
    let weight = 0
    for (const grain of this.activeGrains) {
      if (grain.age >= GRAIN_SIZE) continue
      const window = hannWindow(grain.age, GRAIN_SIZE)
      const readFrame = grain.sourceStartFrame + grain.age * this.sourceToOutputRate
      sum += this.sampleAt(channelIndex, readFrame) * window
      weight += window
    }
    if (weight <= 0.000001) return 0
    return sum / weight
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outputFrames = output[0]?.length || 0
    if (
      (!this.sourceChannels.length && !this.sourceChunks.length) ||
      this.frameCount <= 1 ||
      outputFrames <= 0
    ) {
      for (let ch = 0; ch < output.length; ch += 1) {
        output[ch].fill(0)
      }
      return true
    }

    for (let i = 0; i < outputFrames; i += 1) {
      const timeSec = currentTime + i / Math.max(1, sampleRate)
      if (!this.started || timeSec < this.startTimeSec) {
        for (let ch = 0; ch < output.length; ch += 1) {
          output[ch][i] = 0
        }
        continue
      }
      if (this.stopTimeSec !== null && timeSec >= this.stopTimeSec) {
        this.playing = false
      }
      this.currentRate += (this.targetRate - this.currentRate) * this.rateSmoothFactor

      if (this.playing && this.framesUntilNextGrain <= 0) {
        this.spawnGrain()
      }

      for (let ch = 0; ch < output.length; ch += 1) {
        output[ch][i] = this.playing ? this.renderSample(ch) : 0
      }

      for (let index = this.activeGrains.length - 1; index >= 0; index -= 1) {
        const grain = this.activeGrains[index]
        grain.age += 1
        if (grain.age >= GRAIN_SIZE) {
          this.activeGrains.splice(index, 1)
        }
      }
      this.framesUntilNextGrain -= 1

      if (
        this.playing &&
        this.nextSourceFrame >= this.frameCount &&
        this.activeGrains.length === 0
      ) {
        this.playing = false
      }
    }

    this.reportCounter += outputFrames
    if (this.reportCounter >= POSITION_REPORT_INTERVAL) {
      this.reportCounter = 0
      const latestFrame =
        this.activeGrains[0]?.sourceStartFrame ??
        clamp(this.nextSourceFrame, 0, this.frameCount - 1)
      this.port.postMessage({
        type: 'position',
        frame: latestFrame
      })
    }

    if (!this.playing && this.started && !this.activeGrains.length && !this.endedPosted) {
      this.endedPosted = true
      this.port.postMessage({ type: 'ended' })
    }
    return true
  }
}

registerProcessor(WORKLET_NAME, MixtapeTransportKeyLockProcessor)
