import mitt from 'mitt'

export type WebAudioPlayerEvents = {
  ready: undefined
  play: undefined
  pause: undefined
  finish: undefined
  seeked: number
  timeupdate: number
  decode: number
  error: any
} & Record<string, unknown>

export class WebAudioPlayer {
  public audioBuffer: AudioBuffer | null = null
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

  loadPCM(pcmData: Float32Array, sampleRate: number, channels: number): void {
    this.stopInternal()
    this.audioBuffer = null

    try {
      // 创建 AudioBuffer
      const frameCount = pcmData.length / channels
      this.audioBuffer = this.audioContext.createBuffer(channels, frameCount, sampleRate)

      // 将交错 PCM 数据分离到各个声道
      for (let ch = 0; ch < channels; ch++) {
        const channelData = this.audioBuffer.getChannelData(ch)
        for (let i = 0; i < frameCount; i++) {
          channelData[i] = pcmData[i * channels + ch]
        }
      }

      const duration = this.audioBuffer.duration
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

  seek(time: number): void {
    const wasPlaying = this.isPlayingFlag
    this.pause()
    this.pausedTime = Math.max(0, Math.min(time, this.getDuration()))
    this.emit('seeked', this.pausedTime)
    if (wasPlaying) {
      this.play()
    } else {
      this.emit('timeupdate', this.pausedTime)
    }
  }

  skip(seconds: number): void {
    const currentTime = this.getCurrentTime()
    const newTime = Math.max(0, Math.min(currentTime + seconds, this.getDuration()))
    this.seek(newTime)
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
    this.audioBuffer = null
    this.pausedTime = 0
    this.startTime = 0
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

  destroy(): void {
    this.stopInternal()
    this.empty()
    this.removeAllListeners()
  }
}
