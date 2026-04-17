const WORKLET_NAME = 'mixtape-transport-sequencer'
const MIN_RATE = 0.25
const MAX_RATE = 4
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

class MixtapeTransportSequencerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sourceChannels = []
    this.frameCount = 0
    this.sourceSampleRate = sampleRate
    this.sourceToOutputRate = 1
    this.sequenceSegments = []
    this.sequenceTotalFrames = 0
    this.outputChannels = 2
    this.startTimeSec = 0
    this.stopTimeSec = null
    this.started = false
    this.playing = false
    this.endedPosted = false
    this.currentRate = 1
    this.targetRate = 1
    this.rateSmoothFactor = 0.02
    this.currentPlanFrame = 0
    this.reportCounter = 0

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'set-source') {
        const channels = Array.isArray(data.channels) ? data.channels : []
        this.sourceChannels = channels.filter((item) => item instanceof Float32Array)
        this.frameCount = Math.max(0, Number(data.frameCount) || 0)
        this.sourceSampleRate = Math.max(1, Number(data.sampleRate) || sampleRate)
        this.sourceToOutputRate = this.sourceSampleRate / Math.max(1, sampleRate)
        this.outputChannels = Math.max(
          1,
          Number(data.outputChannels) || this.sourceChannels.length || 2
        )
        this.sequenceSegments = []
        this.sequenceTotalFrames = this.frameCount
        this.resetState()
      } else if (data.type === 'set-sequence') {
        const rawSegments = Array.isArray(data.segments) ? data.segments : []
        const segments = []
        let planCursor = 0
        for (let index = 0; index < rawSegments.length; index += 1) {
          const segment = rawSegments[index]
          const sourceStartFrame = Math.max(0, Math.floor(Number(segment?.sourceStartFrame) || 0))
          const frameCount = Math.max(0, Math.floor(Number(segment?.frameCount) || 0))
          if (frameCount <= 0) continue
          const sourceEndFrame = Math.min(this.frameCount, sourceStartFrame + frameCount)
          if (sourceEndFrame <= sourceStartFrame) continue
          const planStartFrame = planCursor
          planCursor += sourceEndFrame - sourceStartFrame
          segments.push({
            sourceStartFrame,
            sourceEndFrame,
            planStartFrame,
            planEndFrame: planCursor
          })
        }
        this.sequenceSegments = segments
        this.sequenceTotalFrames = planCursor > 0 ? planCursor : this.frameCount
      } else if (data.type === 'dispose') {
        this.sourceChannels = []
        this.frameCount = 0
        this.sequenceSegments = []
        this.sequenceTotalFrames = 0
        this.resetState()
      } else if (data.type === 'start') {
        const maxPlanFrame = Math.max(0, this.resolveTotalPlanFrames() - 1)
        this.currentPlanFrame = clamp(Number(data.startFrame) || 0, 0, maxPlanFrame)
        this.startTimeSec = Math.max(0, Number(data.startTimeSec) || currentTime)
        this.stopTimeSec = null
        this.currentRate = clamp(Number(data.rate) || 1, MIN_RATE, MAX_RATE)
        this.targetRate = this.currentRate
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
    this.currentPlanFrame = 0
    this.reportCounter = 0
  }

  resolveTotalPlanFrames() {
    return this.sequenceTotalFrames > 0 ? this.sequenceTotalFrames : this.frameCount
  }

  resolveDiscreteSample(channelIndex, frameIndex) {
    const safeFrame = clamp(frameIndex, 0, Math.max(0, this.frameCount - 1))
    const sourceIndex = Math.min(this.sourceChannels.length - 1, channelIndex)
    const channelData = this.sourceChannels[Math.max(0, sourceIndex)]
    return channelData?.[safeFrame] || 0
  }

  resolveSourceFrameFromPlanFrame(planFrame) {
    const totalPlanFrames = this.resolveTotalPlanFrames()
    const safePlanFrame = clamp(planFrame, 0, Math.max(0, totalPlanFrames - 1))
    if (!this.sequenceSegments.length) {
      return clamp(safePlanFrame, 0, Math.max(0, this.frameCount - 1))
    }
    for (let index = 0; index < this.sequenceSegments.length; index += 1) {
      const segment = this.sequenceSegments[index]
      if (safePlanFrame < segment.planStartFrame || safePlanFrame >= segment.planEndFrame) continue
      return clamp(
        segment.sourceStartFrame + (safePlanFrame - segment.planStartFrame),
        segment.sourceStartFrame,
        Math.max(segment.sourceStartFrame, segment.sourceEndFrame - 1)
      )
    }
    const lastSegment = this.sequenceSegments[this.sequenceSegments.length - 1]
    if (!lastSegment) return 0
    return Math.max(lastSegment.sourceStartFrame, lastSegment.sourceEndFrame - 1)
  }

  sampleAt(channelIndex, planFrame) {
    const maxPlanFrame = this.resolveTotalPlanFrames() - 1
    const readFrame = clamp(planFrame, 0, Math.max(0, maxPlanFrame))
    if (this.frameCount < 4) {
      const baseIndex = Math.floor(readFrame)
      const nextIndex = Math.min(maxPlanFrame, baseIndex + 1)
      const frac = readFrame - baseIndex
      const a = this.resolveDiscreteSample(
        channelIndex,
        this.resolveSourceFrameFromPlanFrame(baseIndex)
      )
      const b = this.resolveDiscreteSample(
        channelIndex,
        this.resolveSourceFrameFromPlanFrame(nextIndex)
      )
      return a + (b - a) * frac
    }
    const baseIndex = Math.floor(readFrame)
    const frac = readFrame - baseIndex
    const xm1Index = Math.max(0, baseIndex - 1)
    const x0Index = clamp(baseIndex, 0, maxPlanFrame)
    const x1Index = clamp(baseIndex + 1, 0, maxPlanFrame)
    const x2Index = clamp(baseIndex + 2, 0, maxPlanFrame)
    return cubicHermite(
      frac,
      this.resolveDiscreteSample(channelIndex, this.resolveSourceFrameFromPlanFrame(xm1Index)),
      this.resolveDiscreteSample(channelIndex, this.resolveSourceFrameFromPlanFrame(x0Index)),
      this.resolveDiscreteSample(channelIndex, this.resolveSourceFrameFromPlanFrame(x1Index)),
      this.resolveDiscreteSample(channelIndex, this.resolveSourceFrameFromPlanFrame(x2Index))
    )
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outputFrames = output[0]?.length || 0
    if (!this.sourceChannels.length || this.frameCount <= 1 || outputFrames <= 0) {
      for (let ch = 0; ch < output.length; ch += 1) {
        output[ch].fill(0)
      }
      return true
    }

    const totalPlanFrames = this.resolveTotalPlanFrames()
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

      if (this.playing) {
        for (let ch = 0; ch < output.length; ch += 1) {
          output[ch][i] = this.sampleAt(ch, this.currentPlanFrame)
        }
        this.currentPlanFrame += this.currentRate * this.sourceToOutputRate
        if (this.currentPlanFrame >= totalPlanFrames) {
          this.playing = false
          this.currentPlanFrame = totalPlanFrames
        }
      } else {
        for (let ch = 0; ch < output.length; ch += 1) {
          output[ch][i] = 0
        }
      }
    }

    this.reportCounter += outputFrames
    if (this.reportCounter >= POSITION_REPORT_INTERVAL) {
      this.reportCounter = 0
      this.port.postMessage({
        type: 'position',
        frame: this.currentPlanFrame
      })
    }

    if (!this.playing && this.started && !this.endedPosted) {
      this.endedPosted = true
      this.port.postMessage({ type: 'ended' })
    }
    return true
  }
}

registerProcessor(WORKLET_NAME, MixtapeTransportSequencerProcessor)
