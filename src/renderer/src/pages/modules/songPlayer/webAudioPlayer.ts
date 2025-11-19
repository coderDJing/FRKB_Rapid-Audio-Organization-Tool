import mitt from 'mitt'

export type RGBWaveformBandKey = 'low' | 'mid' | 'high'

export type WaveformStyle = 'SoundCloud' | 'Fine' | 'RGB'

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

type OfflineContextCtor = new (
  numberOfChannels: number,
  length: number,
  sampleRate: number
) => OfflineAudioContext

export class WebAudioPlayer {
  public audioBuffer: AudioBuffer | null = null
  public rgbWaveformData: RGBWaveformData | null = null
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
  private activeFilePath: string | null = null
  private activeBufferBytes = 0
  private waveformFilePath: string | null = null
  private waveformBytes = 0
  private waveformTaskFile: string | null = null

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
    this.releaseActiveBuffer('loadPCM:replace')
    this.audioBuffer = null
    this.rgbWaveformPromise = null

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
    this.rgbWaveformPromise = null
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

  private releaseWaveformData(): void {
    if (this.waveformFilePath) {
      this.waveformFilePath = null
      this.waveformBytes = 0
    }
    this.rgbWaveformData = null
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
