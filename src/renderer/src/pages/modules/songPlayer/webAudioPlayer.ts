import mitt from 'mitt'
import {
  designMixxxBesselBandpass,
  designMixxxBesselHighpass,
  designMixxxBesselLowpass,
  type MixxxBesselCoefficients
} from './mixxxBesselFilter'

export type RGBWaveformBandKey = 'low' | 'mid' | 'high'

export type WaveformStyle = 'SoundCloud' | 'Fine' | 'RGB' | 'Mixxx'

export type RGBWaveformBand = {
  values: Float32Array
  peak: number
}

export type RGBWaveformData = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<RGBWaveformBandKey, RGBWaveformBand>
  globalPeak: number
}

export type MixxxWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft?: Uint8Array
  peakRight?: Uint8Array
}

export type MixxxWaveformData = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<RGBWaveformBandKey, MixxxWaveformBand>
}

type LoadPcmOptions = {
  filePath?: string | null
}

export type SeekedEventPayload = {
  time: number
  manual: boolean
}

export type WebAudioPlayerEvents = {
  ready: undefined
  play: undefined
  pause: undefined
  finish: undefined
  seeked: SeekedEventPayload
  timeupdate: number
  decode: number
  error: any
  rgbwaveformready: undefined
  mixxxwaveformready: undefined
} & Record<string, unknown>

const RGB_WAVEFORM_POINTS_PER_SECOND = 800
const LOWPASS_MAX_HZ = 250
const HIGHPASS_MIN_HZ = 2000
const FILTER_Q = 0.707
const RGB_ENVELOPE_SMOOTHING = 0.65
const RGB_BAND_WEIGHTS: Record<RGBWaveformBandKey, number> = {
  low: 1,
  mid: 1.15,
  high: 1.35
}
const MIXXX_WAVEFORM_POINTS_PER_SECOND = 441
const MIXXX_SUMMARY_MAX_SAMPLES = 2 * 1920
const MIXXX_LOWPASS_MAX_HZ = 600
const MIXXX_HIGHPASS_MIN_HZ = 4000
const MIXXX_HIGH_SCALE_EXP = 0.632

type OfflineContextCtor = new (
  numberOfChannels: number,
  length: number,
  sampleRate: number
) => OfflineAudioContext

export class WebAudioPlayer {
  public audioBuffer: AudioBuffer | null = null
  public rgbWaveformData: RGBWaveformData | null = null
  public mixxxWaveformData: MixxxWaveformData | null = null
  private audioContext: AudioContext
  private sourceNode: AudioBufferSourceNode | null = null
  private gainNode: GainNode
  private startTime: number = 0
  private pausedTime: number = 0
  private isPlayingFlag: boolean = false
  private animationFrameId: number | null = null
  private volume: number = 0.8
  private emitter = mitt<WebAudioPlayerEvents>()
  private suppressEndedCallback: boolean = false
  private mediaStreamDestination: MediaStreamAudioDestinationNode | null = null
  private outputAudioElement: HTMLAudioElement | null = null
  private currentOutputDeviceId: string = ''
  private rgbWaveformPromise: Promise<void> | null = null
  private mixxxWaveformPromise: Promise<void> | null = null
  private activeFilePath: string | null = null
  private activeBufferBytes = 0
  private waveformFilePath: string | null = null
  private waveformBytes = 0
  private waveformTaskFile: string | null = null
  private mixxxWaveformFilePath: string | null = null
  private mixxxWaveformBytes = 0
  private mixxxWaveformTaskFile: string | null = null
  private mixxxBesselCache = new Map<string, MixxxBesselCoefficients>()

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext
    this.gainNode = audioContext.createGain()
    this.gainNode.connect(audioContext.destination)
    this.gainNode.gain.value = this.volume
  }

  on<K extends keyof WebAudioPlayerEvents>(
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ): void {
    this.emitter.on(event, handler as any)
  }

  off<K extends keyof WebAudioPlayerEvents>(
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ): void {
    this.emitter.off(event, handler as any)
  }

  once<K extends keyof WebAudioPlayerEvents>(
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ): void {
    const wrapper = ((payload: any) => {
      this.off(event, wrapper as any)
      ;(handler as any)(payload)
    }) as any
    this.on(event, wrapper)
  }

  private emit<K extends keyof WebAudioPlayerEvents>(
    event: K,
    payload?: WebAudioPlayerEvents[K]
  ): void {
    this.emitter.emit(event, payload as any)
  }

  removeAllListeners<K extends keyof WebAudioPlayerEvents>(event?: K): void {
    // 访问 mitt 内部 all Map 做清理（类型上用 any 规避）
    const all = (this.emitter as any).all
    if (!all) return
    if (event) {
      all.delete(event)
    } else if (all.clear) {
      all.clear()
    }
  }

  loadPCM(
    pcmData: Float32Array,
    sampleRate: number,
    channels: number,
    options?: LoadPcmOptions
  ): void {
    this.stopInternal()
    this.releaseWaveformData()
    this.releaseMixxxWaveformData()
    this.releaseActiveBuffer('loadPCM:replace')
    this.audioBuffer = null
    this.rgbWaveformPromise = null
    this.mixxxWaveformPromise = null
    this.pausedTime = 0
    this.startTime = 0

    try {
      // 创建 AudioBuffer
      const frameCount = Math.floor(pcmData.length / channels)
      this.audioBuffer = this.audioContext.createBuffer(channels, frameCount, sampleRate)

      // 将交错 PCM 数据分离到各个声道
      for (let ch = 0; ch < channels; ch++) {
        const channelData = this.audioBuffer.getChannelData(ch)
        for (let i = 0; i < frameCount; i++) {
          channelData[i] = pcmData[i * channels + ch]
        }
      }

      const duration = this.audioBuffer.duration
      const bufferBytes = frameCount * channels * 4
      const filePath = options?.filePath ?? null
      this.activeFilePath = filePath
      this.activeBufferBytes = bufferBytes
      this.emit('decode', duration)
      this.emit('ready')
    } catch (error) {
      this.emit('error', error)
    }
  }

  play(startTime?: number): void {
    if (!this.audioBuffer) {
      this.emit('error', new Error('No audio buffer loaded'))
      return
    }

    if (this.isPlayingFlag) {
      return
    }

    this.stopInternal()

    const startOffset = startTime !== undefined ? startTime : this.pausedTime

    this.sourceNode = this.audioContext.createBufferSource()
    this.sourceNode.buffer = this.audioBuffer
    this.sourceNode.connect(this.gainNode)

    this.sourceNode.onended = () => {
      if (this.suppressEndedCallback) {
        return
      }
      this.isPlayingFlag = false
      this.pausedTime = 0
      this.startTime = 0
      this.sourceNode = null
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId)
        this.animationFrameId = null
      }
      this.emit('finish')
    }

    this.startTime = this.audioContext.currentTime - startOffset
    this.sourceNode.start(0, startOffset)
    this.isPlayingFlag = true

    this.emit('play')
    this.startTimeUpdate()
  }

  pause(): void {
    if (!this.isPlayingFlag || !this.sourceNode) {
      return
    }

    this.pausedTime = this.getCurrentTime()
    this.stopInternal()
    this.emit('pause')
  }

  stop(): void {
    this.stopInternal()
    this.pausedTime = 0
  }

  private stopInternal(): void {
    if (this.sourceNode) {
      try {
        // 暂停/停止时不触发 onended 的“自然结束”逻辑
        this.suppressEndedCallback = true
        this.sourceNode.stop()
      } catch (e) {
        // 可能已经停止
      }
      this.sourceNode.onended = null
      this.sourceNode.disconnect()
      this.sourceNode = null
    }
    // 本次停止结束，恢复 onended 响应
    this.suppressEndedCallback = false
    this.isPlayingFlag = false
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.gainNode.gain.value = this.volume
  }

  getVolume(): number {
    return this.volume
  }

  seek(time: number, manual = false): void {
    const wasPlaying = this.isPlayingFlag
    this.pause()
    this.pausedTime = Math.max(0, Math.min(time, this.getDuration()))
    this.emit('seeked', {
      time: this.pausedTime,
      manual
    })
    if (wasPlaying) {
      this.play()
    } else {
      this.emit('timeupdate', this.pausedTime)
    }
  }

  skip(seconds: number, manual = false): void {
    const currentTime = this.getCurrentTime()
    const newTime = Math.max(0, Math.min(currentTime + seconds, this.getDuration()))
    this.seek(newTime, manual)
  }

  getCurrentTime(): number {
    if (!this.audioBuffer) {
      return 0
    }

    if (this.isPlayingFlag && this.sourceNode) {
      const elapsed = this.audioContext.currentTime - this.startTime
      return Math.min(elapsed, this.getDuration())
    }

    return this.pausedTime
  }

  getDuration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0
  }

  isPlaying(): boolean {
    return this.isPlayingFlag
  }

  empty(): void {
    this.stopInternal()
    this.releaseActiveBuffer('empty')
    this.audioBuffer = null
    this.pausedTime = 0
    this.startTime = 0
    this.releaseWaveformData()
    this.releaseMixxxWaveformData()
    this.rgbWaveformPromise = null
    this.mixxxWaveformPromise = null
  }

  private startTimeUpdate(): void {
    const update = () => {
      if (this.isPlayingFlag) {
        const currentTime = this.getCurrentTime()
        this.emit('timeupdate', currentTime)
        this.animationFrameId = requestAnimationFrame(update)
      }
    }
    this.animationFrameId = requestAnimationFrame(update)
  }

  public ensureRgbWaveform(force = false): Promise<void> {
    if (!this.audioBuffer || !this.activeFilePath) {
      return Promise.resolve()
    }
    if (!force && this.rgbWaveformData) {
      return Promise.resolve()
    }
    if (this.rgbWaveformPromise) {
      if (this.waveformTaskFile === this.activeFilePath) {
        return this.rgbWaveformPromise
      }
      if (!force) {
        return this.rgbWaveformPromise
      }
    }
    if (!force && this.rgbWaveformPromise) {
      return this.rgbWaveformPromise
    }

    const buffer = this.audioBuffer
    const filePath = this.activeFilePath
    const promise = (async () => {
      try {
        const data = await this.generateRgbWaveform(buffer, filePath)
        if (this.audioBuffer !== buffer || this.activeFilePath !== filePath) {
          return
        }
        if (data) {
          this.rgbWaveformData = data
          if (filePath) {
            const waveformBytes = this.calculateWaveformBytes(data)
            this.waveformFilePath = filePath
            this.waveformBytes = waveformBytes
          }
          this.emit('rgbwaveformready')
        }
      } catch (error) {
        console.warn('[WebAudioPlayer] 生成 RGB 波形失败', error)
        this.releaseWaveformData()
      }
    })()

    this.waveformTaskFile = this.activeFilePath
    this.rgbWaveformPromise = promise
    return promise.finally(() => {
      if (this.rgbWaveformPromise === promise) {
        this.rgbWaveformPromise = null
        this.waveformTaskFile = null
      }
    })
  }

  public ensureMixxxWaveform(force = false): Promise<void> {
    if (!this.audioBuffer || !this.activeFilePath) {
      return Promise.resolve()
    }
    if (!force && this.mixxxWaveformData) {
      return Promise.resolve()
    }
    if (this.mixxxWaveformPromise) {
      if (this.mixxxWaveformTaskFile === this.activeFilePath) {
        return this.mixxxWaveformPromise
      }
      if (!force) {
        return this.mixxxWaveformPromise
      }
    }
    if (!force && this.mixxxWaveformPromise) {
      return this.mixxxWaveformPromise
    }

    const buffer = this.audioBuffer
    const filePath = this.activeFilePath
    const promise = (async () => {
      try {
        const data = await this.generateMixxxWaveform(buffer, filePath)
        if (this.audioBuffer !== buffer || this.activeFilePath !== filePath) {
          return
        }
        if (data) {
          this.mixxxWaveformData = data
          if (filePath) {
            const waveformBytes = this.calculateMixxxWaveformBytes(data)
            this.mixxxWaveformFilePath = filePath
            this.mixxxWaveformBytes = waveformBytes
          }
          this.emit('mixxxwaveformready')
        }
      } catch (error) {
        console.warn('[WebAudioPlayer] 生成 Mixxx 波形失败', error)
        this.releaseMixxxWaveformData()
      }
    })()

    this.mixxxWaveformTaskFile = this.activeFilePath
    this.mixxxWaveformPromise = promise
    return promise.finally(() => {
      if (this.mixxxWaveformPromise === promise) {
        this.mixxxWaveformPromise = null
        this.mixxxWaveformTaskFile = null
      }
    })
  }

  private releaseWaveformData(): void {
    if (this.waveformFilePath) {
      this.waveformFilePath = null
      this.waveformBytes = 0
    }
    this.rgbWaveformData = null
  }

  private releaseMixxxWaveformData(): void {
    if (this.mixxxWaveformFilePath) {
      this.mixxxWaveformFilePath = null
      this.mixxxWaveformBytes = 0
    }
    this.mixxxWaveformData = null
  }

  private releaseActiveBuffer(reason: string): void {
    void reason
    if (!this.activeFilePath) {
      this.activeBufferBytes = 0
      return
    }
    this.activeFilePath = null
    this.activeBufferBytes = 0
  }

  private calculateWaveformBytes(data: RGBWaveformData): number {
    const bands: RGBWaveformBandKey[] = ['low', 'mid', 'high']
    let total = 0
    bands.forEach((band) => {
      const values = data.bands[band]?.values
      if (values) {
        total += values.length * 4
      }
    })
    return total
  }

  private calculateMixxxWaveformBytes(data: MixxxWaveformData): number {
    const bands: RGBWaveformBandKey[] = ['low', 'mid', 'high']
    let total = 0
    bands.forEach((band) => {
      const bandData = data.bands[band]
      if (bandData) {
        total += bandData.left.length
        total += bandData.right.length
        if (bandData.peakLeft) total += bandData.peakLeft.length
        if (bandData.peakRight) total += bandData.peakRight.length
      }
    })
    return total
  }

  private async generateRgbWaveform(
    buffer: AudioBuffer,
    filePath: string | null
  ): Promise<RGBWaveformData | null> {
    if (!buffer.length) {
      return null
    }
    const OfflineCtor: OfflineContextCtor | undefined = ((typeof window !== 'undefined'
      ? (window as any).OfflineAudioContext
      : undefined) ??
      (typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : undefined)) as
      | OfflineContextCtor
      | undefined
    if (typeof OfflineCtor !== 'function') {
      return null
    }

    const step = Math.max(1, Math.floor(buffer.sampleRate / RGB_WAVEFORM_POINTS_PER_SECOND))
    const [low, mid, high] = await Promise.all([
      this.renderBandEnvelope(buffer, 'low', step, OfflineCtor, filePath),
      this.renderBandEnvelope(buffer, 'mid', step, OfflineCtor, filePath),
      this.renderBandEnvelope(buffer, 'high', step, OfflineCtor, filePath)
    ])

    if (!low || !mid || !high) {
      return null
    }

    const globalPeak = Math.max(low.peak, mid.peak, high.peak, 0.0001)

    return {
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      step,
      bands: {
        low,
        mid,
        high
      },
      globalPeak
    }
  }

  private async generateMixxxWaveform(
    buffer: AudioBuffer,
    filePath: string | null
  ): Promise<MixxxWaveformData | null> {
    if (!buffer.length) {
      return null
    }
    const sampleRate = buffer.sampleRate
    const frameLength = buffer.length
    const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
    const analysisChannels = 2
    const mainStride = Math.max(1, sampleRate / MIXXX_WAVEFORM_POINTS_PER_SECOND)
    let summaryVisualSampleRate = sampleRate
    if (frameLength > MIXXX_SUMMARY_MAX_SAMPLES / analysisChannels) {
      summaryVisualSampleRate =
        (sampleRate * MIXXX_SUMMARY_MAX_SAMPLES) / analysisChannels / frameLength
    }
    const summaryStride = sampleRate / summaryVisualSampleRate
    const leftSamples = buffer.getChannelData(0)
    const rightSamples = channelCount > 1 ? buffer.getChannelData(1) : leftSamples
    const [low, mid, high] = await Promise.all([
      this.renderMixxxBand(leftSamples, rightSamples, 'low', mainStride, summaryStride, sampleRate),
      this.renderMixxxBand(leftSamples, rightSamples, 'mid', mainStride, summaryStride, sampleRate),
      this.renderMixxxBand(leftSamples, rightSamples, 'high', mainStride, summaryStride, sampleRate)
    ])

    if (!low || !mid || !high) {
      return null
    }

    return {
      duration: buffer.duration,
      sampleRate,
      step: summaryStride,
      bands: {
        low,
        mid,
        high
      }
    }
  }

  private async renderBandEnvelope(
    buffer: AudioBuffer,
    band: RGBWaveformBandKey,
    step: number,
    OfflineCtor: OfflineContextCtor,
    filePath: string | null
  ): Promise<RGBWaveformBand | null> {
    try {
      const offlineCtx = new OfflineCtor(1, buffer.length, buffer.sampleRate)
      const source = offlineCtx.createBufferSource()
      const offlineBuffer = offlineCtx.createBuffer(1, buffer.length, buffer.sampleRate)
      offlineBuffer.copyToChannel(buffer.getChannelData(0), 0, 0)
      source.buffer = offlineBuffer
      const { input, output } = this.createBandFilter(offlineCtx, band)
      source.connect(input)
      output.connect(offlineCtx.destination)
      source.start(0)
      const rendered = await offlineCtx.startRendering()
      const channelData = rendered.getChannelData(0)
      return this.downsampleBand(channelData, band, step)
    } catch (error) {
      console.warn(`[WebAudioPlayer] 渲染 ${band} 频段波形失败`, error)
      return null
    } finally {
    }
  }

  private async renderMixxxBand(
    leftSamples: Float32Array,
    rightSamples: Float32Array,
    band: RGBWaveformBandKey,
    mainStride: number,
    summaryStride: number,
    sampleRate: number
  ): Promise<MixxxWaveformBand | null> {
    try {
      const coeffs = this.getMixxxBesselCoefficients(band, sampleRate)
      return this.downsampleMixxxBand(
        leftSamples,
        rightSamples,
        band,
        mainStride,
        summaryStride,
        coeffs
      )
    } catch (error) {
      console.warn(`[WebAudioPlayer] 渲染 Mixxx ${band} 频段波形失败`, error)
      return null
    }
  }

  private createBandFilter(
    context: BaseAudioContext,
    band: RGBWaveformBandKey
  ): { input: AudioNode; output: AudioNode } {
    if (band === 'low') {
      const lowpass = context.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.frequency.value = LOWPASS_MAX_HZ
      lowpass.Q.value = FILTER_Q
      return { input: lowpass, output: lowpass }
    }
    if (band === 'high') {
      const highpass = context.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = HIGHPASS_MIN_HZ
      highpass.Q.value = FILTER_Q
      return { input: highpass, output: highpass }
    }

    const highpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = LOWPASS_MAX_HZ
    highpass.Q.value = FILTER_Q

    const lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = HIGHPASS_MIN_HZ
    lowpass.Q.value = FILTER_Q

    highpass.connect(lowpass)
    return { input: highpass, output: lowpass }
  }

  private downsampleBand(
    samples: Float32Array,
    band: RGBWaveformBandKey,
    step: number
  ): RGBWaveformBand {
    const length = Math.ceil(samples.length / step)
    const values = new Float32Array(length)
    let peak = 0
    let previous = 0
    const smoothingFactor = Math.max(0, Math.min(1, 1 - RGB_ENVELOPE_SMOOTHING))

    for (let i = 0; i < length; i++) {
      const start = i * step
      const end = Math.min(start + step, samples.length)
      let sumSquares = 0
      let count = 0

      for (let j = start; j < end; j++) {
        const sample = samples[j]
        sumSquares += sample * sample
        count++
      }

      const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0
      const smoothed = i === 0 ? rms : previous + (rms - previous) * smoothingFactor
      const weight = RGB_BAND_WEIGHTS[band] ?? 1
      const value = smoothed * weight
      values[i] = value
      if (value > peak) {
        peak = value
      }
      previous = smoothed
    }

    return {
      values,
      peak
    }
  }

  private downsampleMixxxBand(
    leftSamples: Float32Array,
    rightSamples: Float32Array,
    band: RGBWaveformBandKey,
    mainStride: number,
    summaryStride: number,
    coeffs: MixxxBesselCoefficients
  ): MixxxWaveformBand {
    const totalSamples = Math.min(leftSamples.length, rightSamples.length)
    const leftValues: number[] = []
    const rightValues: number[] = []
    const leftPeakValues: number[] = []
    const rightPeakValues: number[] = []
    let position = 0
    let nextMainStore = mainStride
    let nextSummaryStore = summaryStride
    let leftPeak = 0
    let rightPeak = 0
    let leftAverage = 0
    let rightAverage = 0
    let averageDivisor = 0
    let leftPeakMax = 0
    let rightPeakMax = 0
    const leftState = new Float64Array(coeffs.order)
    const rightState = new Float64Array(coeffs.order)

    for (let i = 0; i < totalSamples; i++) {
      const l = Math.abs(
        this.processMixxxBandSample(band, coeffs.coefficients, leftState, leftSamples[i])
      )
      const r = Math.abs(
        this.processMixxxBandSample(band, coeffs.coefficients, rightState, rightSamples[i])
      )
      if (l > leftPeak) leftPeak = l
      if (r > rightPeak) rightPeak = r

      position += 1
      if (position >= nextMainStore) {
        if (leftPeak > leftPeakMax) leftPeakMax = leftPeak
        if (rightPeak > rightPeakMax) rightPeakMax = rightPeak
        leftAverage += leftPeak
        rightAverage += rightPeak
        averageDivisor += 1
        leftPeak = 0
        rightPeak = 0
        nextMainStore += mainStride
      }
      if (position >= nextSummaryStore) {
        const leftValue = averageDivisor > 0 ? leftAverage / averageDivisor : leftPeak
        const rightValue = averageDivisor > 0 ? rightAverage / averageDivisor : rightPeak
        const leftPeakValue = averageDivisor > 0 ? leftPeakMax : leftPeak
        const rightPeakValue = averageDivisor > 0 ? rightPeakMax : rightPeak
        leftValues.push(this.scaleMixxxValue(leftValue, band))
        rightValues.push(this.scaleMixxxValue(rightValue, band))
        leftPeakValues.push(this.scaleMixxxValue(leftPeakValue, band))
        rightPeakValues.push(this.scaleMixxxValue(rightPeakValue, band))
        leftAverage = 0
        rightAverage = 0
        averageDivisor = 0
        leftPeakMax = 0
        rightPeakMax = 0
        nextSummaryStore += summaryStride
      }
    }

    const expectedFrames = Math.floor(totalSamples / summaryStride) + 1
    while (leftValues.length < expectedFrames) {
      leftValues.push(0)
      rightValues.push(0)
      leftPeakValues.push(0)
      rightPeakValues.push(0)
    }
    if (leftValues.length > expectedFrames) {
      leftValues.length = expectedFrames
      rightValues.length = expectedFrames
      leftPeakValues.length = expectedFrames
      rightPeakValues.length = expectedFrames
    }

    return {
      left: Uint8Array.from(leftValues),
      right: Uint8Array.from(rightValues),
      peakLeft: Uint8Array.from(leftPeakValues),
      peakRight: Uint8Array.from(rightPeakValues)
    }
  }

  private getMixxxBesselCoefficients(
    band: RGBWaveformBandKey,
    sampleRate: number
  ): MixxxBesselCoefficients {
    const key = `${band}:${sampleRate}`
    const cached = this.mixxxBesselCache.get(key)
    if (cached) {
      return cached
    }
    let coeffs: MixxxBesselCoefficients
    if (band === 'low') {
      coeffs = designMixxxBesselLowpass(sampleRate, MIXXX_LOWPASS_MAX_HZ)
    } else if (band === 'high') {
      coeffs = designMixxxBesselHighpass(sampleRate, MIXXX_HIGHPASS_MIN_HZ)
    } else {
      coeffs = designMixxxBesselBandpass(sampleRate, MIXXX_LOWPASS_MAX_HZ, MIXXX_HIGHPASS_MIN_HZ)
    }
    this.mixxxBesselCache.set(key, coeffs)
    return coeffs
  }

  private processMixxxBandSample(
    band: RGBWaveformBandKey,
    coefficients: Float64Array,
    state: Float64Array,
    value: number
  ): number {
    if (band === 'mid') {
      return this.processMixxxBandpassSample(coefficients, state, value)
    }
    if (band === 'high') {
      return this.processMixxxHighpassSample(coefficients, state, value)
    }
    return this.processMixxxLowpassSample(coefficients, state, value)
  }

  private processMixxxLowpassSample(
    coefficients: Float64Array,
    state: Float64Array,
    value: number
  ): number {
    let tmp = state[0]
    state[0] = state[1]
    state[1] = state[2]
    state[2] = state[3]
    let iir = value * coefficients[0]
    iir -= coefficients[1] * tmp
    let fir = tmp
    iir -= coefficients[2] * state[0]
    fir += state[0] + state[0]
    fir += iir
    tmp = state[1]
    state[1] = iir
    value = fir
    iir = value
    iir -= coefficients[3] * tmp
    fir = tmp
    iir -= coefficients[4] * state[2]
    fir += state[2] + state[2]
    fir += iir
    state[3] = iir
    return fir
  }

  private processMixxxHighpassSample(
    coefficients: Float64Array,
    state: Float64Array,
    value: number
  ): number {
    let tmp = state[0]
    state[0] = state[1]
    state[1] = state[2]
    state[2] = state[3]
    let iir = value * coefficients[0]
    iir -= coefficients[1] * tmp
    let fir = tmp
    iir -= coefficients[2] * state[0]
    fir += -state[0] - state[0]
    fir += iir
    tmp = state[1]
    state[1] = iir
    value = fir
    iir = value
    iir -= coefficients[3] * tmp
    fir = tmp
    iir -= coefficients[4] * state[2]
    fir += -state[2] - state[2]
    fir += iir
    state[3] = iir
    return fir
  }

  private processMixxxBandpassSample(
    coefficients: Float64Array,
    state: Float64Array,
    value: number
  ): number {
    let tmp = state[0]
    state[0] = state[1]
    state[1] = state[2]
    state[2] = state[3]
    state[3] = state[4]
    state[4] = state[5]
    state[5] = state[6]
    state[6] = state[7]
    let iir = value * coefficients[0]
    iir -= coefficients[1] * tmp
    let fir = tmp
    iir -= coefficients[2] * state[0]
    fir += -state[0] - state[0]
    fir += iir
    tmp = state[1]
    state[1] = iir
    value = fir
    iir = value
    iir -= coefficients[3] * tmp
    fir = tmp
    iir -= coefficients[4] * state[2]
    fir += -state[2] - state[2]
    fir += iir
    tmp = state[3]
    state[3] = iir
    value = fir
    iir = value
    iir -= coefficients[5] * tmp
    fir = tmp
    iir -= coefficients[6] * state[4]
    fir += state[4] + state[4]
    fir += iir
    tmp = state[5]
    state[5] = iir
    value = fir
    iir = value
    iir -= coefficients[7] * tmp
    fir = tmp
    iir -= coefficients[8] * state[6]
    fir += state[6] + state[6]
    fir += iir
    state[7] = iir
    return fir
  }

  private scaleMixxxValue(value: number, band: RGBWaveformBandKey): number {
    if (!value) return 0
    const scaled = band === 'high' ? Math.pow(value, MIXXX_HIGH_SCALE_EXP) : value
    return Math.max(0, Math.min(255, Math.round(scaled * 255)))
  }

  destroy(): void {
    this.stopInternal()
    this.empty()
    this.routeToSystemDestination()
    this.removeAllListeners()
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const normalized = deviceId || ''
    if (normalized === this.currentOutputDeviceId) {
      return
    }
    if (!normalized) {
      this.routeToSystemDestination()
      this.currentOutputDeviceId = ''
      return
    }
    const canSetSink = typeof (HTMLMediaElement.prototype as any)?.setSinkId === 'function'
    if (!canSetSink) {
      throw new Error('setSinkIdUnsupported')
    }
    try {
      await this.routeToSpecificDevice(normalized)
      this.currentOutputDeviceId = normalized
    } catch (error) {
      this.routeToSystemDestination()
      this.currentOutputDeviceId = ''
      throw error
    }
  }

  private routeToSystemDestination(): void {
    try {
      this.gainNode.disconnect()
    } catch (_) {}
    this.gainNode.connect(this.audioContext.destination)
    if (this.outputAudioElement) {
      try {
        this.outputAudioElement.pause()
      } catch (_) {}
      this.outputAudioElement.srcObject = null
      this.outputAudioElement = null
    }
    if (this.mediaStreamDestination) {
      try {
        this.mediaStreamDestination.disconnect()
      } catch (_) {}
      this.mediaStreamDestination = null
    }
    this.currentOutputDeviceId = ''
  }

  private async routeToSpecificDevice(deviceId: string): Promise<void> {
    if (!this.mediaStreamDestination) {
      this.mediaStreamDestination = this.audioContext.createMediaStreamDestination()
    }
    try {
      this.gainNode.disconnect()
    } catch (_) {}
    this.gainNode.connect(this.mediaStreamDestination)
    if (!this.outputAudioElement) {
      this.outputAudioElement = document.createElement('audio')
      this.outputAudioElement.autoplay = true
      this.outputAudioElement.muted = false
      this.outputAudioElement.volume = 1
      ;(this.outputAudioElement as any).playsInline = true
    }
    const element = this.outputAudioElement
    const stream = this.mediaStreamDestination.stream
    if (element.srcObject !== stream) {
      element.srcObject = stream
    }
    const sinkElement = element as any
    if (typeof sinkElement.setSinkId !== 'function') {
      throw new Error('setSinkIdUnsupported')
    }
    await sinkElement.setSinkId(deviceId)
    try {
      await element.play()
    } catch (_) {
      // 播放器可能处于暂停状态，忽略自动播放失败
    }
  }
}
