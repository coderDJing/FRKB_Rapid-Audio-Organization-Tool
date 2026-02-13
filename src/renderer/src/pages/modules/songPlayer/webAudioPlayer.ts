import mitt from 'mitt'

export type RGBWaveformBandKey = 'low' | 'mid' | 'high'
export type MixxxWaveformBandKey = RGBWaveformBandKey | 'all'

export type WaveformStyle = 'SoundCloud' | 'Fine' | 'RGB'

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
  bands: Record<MixxxWaveformBandKey, MixxxWaveformBand>
}

type LoadFileOptions = {
  filePath?: string | null
  mixxxWaveformData?: MixxxWaveformData | null
  audioElement?: HTMLAudioElement | null
}

export type PcmLoadPayload = {
  pcmData: Float32Array | ArrayBuffer | ArrayBufferView | null
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
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
  mixxxwaveformready: undefined
} & Record<string, unknown>

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  ac3: 'audio/ac3',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  alac: 'audio/mp4',
  ape: 'audio/x-ape',
  dts: 'audio/vnd.dts',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mka: 'audio/x-matroska',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  tak: 'audio/x-tak',
  tta: 'audio/x-tta',
  wav: 'audio/wav',
  wave: 'audio/wav',
  webm: 'audio/webm',
  wma: 'audio/x-ms-wma',
  wv: 'audio/x-wavpack'
}

const htmlAudioSupportCache = new Map<string, boolean>()

const normalizeExtension = (filePath: string) => {
  const raw = (filePath || '').trim().toLowerCase()
  if (!raw) return ''
  const match = raw.match(/\.([a-z0-9]+)$/i)
  return match ? match[1] : ''
}

// 强制使用后端解码的扩展名
// 后端解码策略：优先 Symphonia (快)，不支持时自动降级到 FFmpeg
//
// Symphonia 支持: AAC, M4A(AAC), MP3, FLAC, WAV, AIFF, Ogg/Vorbis
// FFmpeg 降级支持: ALAC, APE, TAK, TTA, WavPack, DTS, AC3, WMA, Opus 等
const FORCE_PCM_EXTENSIONS = new Set([
  // 容器格式（可能包含多种编解码器，不可靠）
  'm4a', // M4A: 如果是 AAC → Symphonia(快)；如果是 ALAC → FFmpeg
  'm4b', // M4B (有声书): 同 M4A
  'mp4', // MP4 音频: 同 M4A
  'mka', // Matroska: FFmpeg
  'webm', // WebM: FFmpeg

  // 无损/专业格式（浏览器不支持，需要后端解码）
  'alac', // Apple Lossless → FFmpeg
  'ape', // Monkey's Audio → FFmpeg
  'tak', // TAK → FFmpeg
  'tta', // True Audio → FFmpeg
  'wv', // WavPack → FFmpeg

  // 专业音频格式（浏览器不支持）
  'dts', // DTS → FFmpeg
  'ac3', // AC3/Dolby Digital → FFmpeg
  'wma', // Windows Media Audio → FFmpeg

  // AAC 裸流（容器不完整，不可靠）
  'aac' // AAC 裸流 → Symphonia/FFmpeg
])

// 浏览器原生支持良好的格式（保持 HTML 直接播放，性能最佳）：
// - mp3: 浏览器原生支持 ✅
// - wav: 浏览器原生支持 ✅
// - flac: 现代浏览器支持 ✅
// - ogg/oga: Vorbis，浏览器支持 ✅
// - opus: 现代浏览器支持 ✅
// - aif/aiff: 部分浏览器支持 ✅

export const canPlayHtmlAudio = (filePath: string) => {
  const ext = normalizeExtension(filePath)
  if (!ext) return false

  // 黑名单：强制使用 PCM 解码
  if (FORCE_PCM_EXTENSIONS.has(ext)) return false

  const mime = AUDIO_MIME_BY_EXTENSION[ext]
  if (!mime) return false
  if (typeof document === 'undefined') return true
  const cached = htmlAudioSupportCache.get(mime)
  if (cached !== undefined) return cached
  const audio = document.createElement('audio')
  const result = audio.canPlayType(mime)
  const supported = result === 'probably' || result === 'maybe'
  htmlAudioSupportCache.set(mime, supported)
  return supported
}

export const toPreviewUrl = (filePath: string) => {
  const raw = (filePath || '').trim()
  if (!raw) return ''
  if (raw.startsWith('frkb-preview://')) return raw
  return `frkb-preview://local/?path=${encodeURIComponent(raw)}`
}

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) {
    return new Float32Array(0)
  }
  if (pcmData instanceof Float32Array) {
    return pcmData
  }
  if (pcmData instanceof ArrayBuffer) {
    return new Float32Array(pcmData)
  }
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

export class WebAudioPlayer {
  public audioBuffer: AudioBuffer | null = null
  public mixxxWaveformData: MixxxWaveformData | null = null
  private emitter = mitt<WebAudioPlayerEvents>()
  private isPlayingFlag = false
  private animationFrameId: number | null = null
  private volume: number = 0.8
  private pendingSeekTime: number | null = null
  private pendingPlay = false
  private metadataReady = false
  private currentOutputDeviceId: string = ''
  private activeFilePath: string | null = null
  private activeSrc = ''
  private mixxxWaveformFilePath: string | null = null
  private mixxxWaveformBytes = 0
  private suppressPauseEvent = false
  private mode: 'none' | 'html' | 'pcm' = 'none'

  private audioElement: HTMLAudioElement | null = null
  private audioHandlers: {
    loadedmetadata: () => void
    play: () => void
    pause: () => void
    ended: () => void
    error: () => void
  } | null = null

  private pcmContext: AudioContext | null = null
  private pcmGainNode: GainNode | null = null
  private pcmSourceNode: AudioBufferSourceNode | null = null
  private pcmOffset = 0
  private pcmStartTime = 0
  private pcmDuration = 0
  private pcmSuppressEnded = false

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
    const all = (this.emitter as any).all
    if (!all) return
    if (event) {
      all.delete(event)
    } else if (all.clear) {
      all.clear()
    }
  }

  getAudioElement(): HTMLAudioElement | null {
    return this.mode === 'html' ? this.audioElement : null
  }

  isReady(): boolean {
    return this.metadataReady
  }

  hasSource(): boolean {
    if (this.mode === 'pcm') {
      return Boolean(this.audioBuffer)
    }
    return Boolean(this.audioElement?.src)
  }

  loadFile(filePath: string, options?: LoadFileOptions): void {
    const normalized = (filePath || options?.filePath || '').trim()
    if (!normalized) {
      this.emit('error', new Error('No file path provided'))
      return
    }

    this.switchToHtml()
    this.stopInternal()
    this.audioBuffer = null
    this.pendingSeekTime = null
    this.pendingPlay = false
    this.metadataReady = false
    this.releaseMixxxWaveformData()

    const audio = options?.audioElement ?? this.createAudioElement()
    this.attachAudioElement(audio)

    const src = toPreviewUrl(normalized)
    this.activeFilePath = normalized
    this.activeSrc = src

    const isPreloaded = Boolean(options?.audioElement)
    const sourceChanged = !isPreloaded && audio.src !== src
    if (isPreloaded) {
      if (!audio.src) {
        audio.src = src
      }
    } else if (sourceChanged) {
      audio.src = src
    }
    audio.preload = 'auto'
    audio.autoplay = false
    audio.muted = false
    audio.volume = this.volume
    if (!isPreloaded || sourceChanged) {
      try {
        audio.load()
      } catch (error) {
        this.emit('error', error)
      }
    }

    if (options?.mixxxWaveformData !== undefined) {
      this.setMixxxWaveformData(options.mixxxWaveformData ?? null, normalized)
    }

    if (audio.readyState >= 1) {
      this.handleMetadataReady()
    }
  }

  loadPCM(payload: PcmLoadPayload): void {
    const filePath = (payload?.filePath || '').trim()
    const pcmData = normalizePcmData(payload?.pcmData)
    const sampleRate = payload?.sampleRate ?? 0
    const channels = Math.max(1, payload?.channels ?? 1)
    const totalFrames = payload?.totalFrames ?? 0

    if (!pcmData.length || !sampleRate || !channels) {
      this.emit('error', new Error('Empty PCM payload'))
      return
    }

    this.switchToPcm()
    this.stopInternal()
    this.pendingSeekTime = null
    this.pendingPlay = false
    this.metadataReady = false
    this.releaseMixxxWaveformData()

    const context = this.ensurePcmContext(sampleRate)
    if (!context) {
      this.emit('error', new Error('AudioContext unavailable'))
      return
    }

    const frameCount =
      totalFrames > 0 ? Math.min(totalFrames, Math.floor(pcmData.length / channels)) : 0
    const safeFrames = frameCount || Math.floor(pcmData.length / channels)
    if (safeFrames <= 0) {
      this.emit('error', new Error('Invalid PCM frames'))
      return
    }

    const buffer = context.createBuffer(channels, safeFrames, sampleRate)
    for (let channel = 0; channel < channels; channel++) {
      const channelData = buffer.getChannelData(channel)
      let readIndex = channel
      for (let i = 0; i < safeFrames; i++) {
        channelData[i] = pcmData[readIndex] || 0
        readIndex += channels
      }
    }

    this.audioBuffer = buffer
    this.pcmDuration = buffer.duration
    this.pcmOffset = 0
    this.pcmStartTime = 0
    this.activeFilePath = filePath || this.activeFilePath
    this.activeSrc = ''

    if (payload?.mixxxWaveformData !== undefined) {
      this.setMixxxWaveformData(payload.mixxxWaveformData ?? null, filePath || undefined)
    }

    this.handleMetadataReady()
  }

  play(startTime?: number): void {
    if (typeof startTime === 'number' && Number.isFinite(startTime)) {
      this.pendingSeekTime = Math.max(0, startTime)
    }

    if (!this.metadataReady) {
      this.pendingPlay = true
      return
    }

    if (this.mode === 'pcm' && this.isPlayingFlag) {
      if (this.pendingSeekTime !== null) {
        const target = this.pendingSeekTime
        this.pendingSeekTime = null
        this.seek(target, false)
      }
      return
    }

    this.startPlayback()
  }

  pause(): void {
    if (this.mode === 'pcm') {
      this.pausePcm()
      return
    }
    const audio = this.audioElement
    if (!audio) return
    if (audio.paused) return
    this.pendingPlay = false
    this.suppressPauseEvent = false
    try {
      audio.pause()
    } catch (_) {}
  }

  stop(): void {
    this.pendingPlay = false
    this.stopInternal(true)
  }

  private stopInternal(resetTime = false): void {
    if (this.mode === 'pcm') {
      this.stopPcmInternal(resetTime)
      return
    }
    this.stopHtmlInternal(resetTime)
  }

  private stopHtmlInternal(resetTime = false): void {
    const audio = this.audioElement
    if (!audio) {
      this.isPlayingFlag = false
      this.stopTimeUpdate()
      return
    }
    const wasPlaying = !audio.paused
    this.suppressPauseEvent = wasPlaying
    try {
      audio.pause()
    } catch (_) {}
    if (!wasPlaying) {
      this.suppressPauseEvent = false
    }
    if (resetTime) {
      try {
        audio.currentTime = 0
      } catch (_) {}
    }
    this.isPlayingFlag = false
    this.stopTimeUpdate()
  }

  private stopPcmInternal(resetTime = false): void {
    this.stopPcmSource(true)
    if (resetTime) {
      this.pcmOffset = 0
    }
    this.isPlayingFlag = false
    this.stopTimeUpdate()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.mode === 'pcm' && this.pcmGainNode) {
      this.pcmGainNode.gain.value = this.volume
      return
    }
    if (this.audioElement) {
      this.audioElement.volume = this.volume
    }
  }

  getVolume(): number {
    return this.volume
  }

  seek(time: number, manual = false): void {
    if (this.mode === 'pcm') {
      this.seekPcm(time, manual)
      return
    }
    const audio = this.audioElement
    if (!audio) return

    const duration = this.getDuration()
    const nextTime = duration > 0 ? clampNumber(time, 0, duration) : Math.max(0, time)

    if (!this.metadataReady) {
      this.pendingSeekTime = nextTime
      this.emit('seeked', { time: nextTime, manual })
      return
    }

    try {
      if (typeof (audio as any).fastSeek === 'function') {
        ;(audio as any).fastSeek(nextTime)
      } else {
        audio.currentTime = nextTime
      }
    } catch (_) {}

    this.emit('seeked', { time: nextTime, manual })
    if (!this.isPlayingFlag) {
      this.emit('timeupdate', nextTime)
    }
  }

  skip(seconds: number, manual = false): void {
    const currentTime = this.getCurrentTime()
    this.seek(currentTime + seconds, manual)
  }

  getCurrentTime(): number {
    if (this.mode === 'pcm') {
      return this.getPcmCurrentTime()
    }
    const audio = this.audioElement
    if (!audio) return 0
    if (!this.metadataReady) return 0
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0
  }

  getDuration(): number {
    if (this.mode === 'pcm') {
      return Number.isFinite(this.pcmDuration) ? this.pcmDuration : 0
    }
    const audio = this.audioElement
    if (!audio) return 0
    const duration = audio.duration
    return Number.isFinite(duration) ? duration : 0
  }

  isPlaying(): boolean {
    return this.isPlayingFlag
  }

  empty(): void {
    this.pendingPlay = false
    this.stopInternal(true)
    this.audioBuffer = null
    this.pcmDuration = 0
    this.pcmOffset = 0
    this.pcmStartTime = 0
    this.pendingSeekTime = null
    this.metadataReady = false
    this.releaseMixxxWaveformData()
    this.activeFilePath = null
    this.activeSrc = ''
    this.detachAudioElement(true)
  }

  private startTimeUpdate(): void {
    const update = () => {
      if (this.isPlayingFlag) {
        this.emit('timeupdate', this.getCurrentTime())
        this.animationFrameId = requestAnimationFrame(update)
      }
    }
    this.animationFrameId = requestAnimationFrame(update)
  }

  private stopTimeUpdate(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  setMixxxWaveformData(data: MixxxWaveformData | null, filePath?: string | null): void {
    if (!data) {
      this.releaseMixxxWaveformData()
      return
    }
    this.mixxxWaveformData = data
    if (filePath) {
      this.mixxxWaveformFilePath = filePath
      this.mixxxWaveformBytes = this.calculateMixxxWaveformBytes(data)
    }
    this.emit('mixxxwaveformready')
  }

  private releaseMixxxWaveformData(): void {
    if (this.mixxxWaveformFilePath) {
      this.mixxxWaveformFilePath = null
      this.mixxxWaveformBytes = 0
    }
    this.mixxxWaveformData = null
  }

  private calculateMixxxWaveformBytes(data: MixxxWaveformData): number {
    const bands: MixxxWaveformBandKey[] = ['low', 'mid', 'high', 'all']
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

  destroy(): void {
    this.stopInternal(true)
    this.empty()
    this.removeAllListeners()
    this.releasePcmContext()
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const normalized = deviceId || ''
    if (normalized === this.currentOutputDeviceId) {
      return
    }
    this.currentOutputDeviceId = normalized
    if (this.mode === 'pcm') {
      const context = this.pcmContext
      if (!context) {
        return
      }
      await this.applyOutputDeviceToContext(context, normalized)
      return
    }
    const audio = this.audioElement
    if (!audio) {
      return
    }
    const setSinkId = (audio as any)?.setSinkId
    if (typeof setSinkId !== 'function') {
      throw new Error('setSinkIdUnsupported')
    }
    try {
      await setSinkId.call(audio, normalized)
    } catch (error) {
      if (normalized) {
        this.currentOutputDeviceId = ''
      }
      throw error
    }
  }

  private createAudioElement(): HTMLAudioElement {
    const audio = document.createElement('audio')
    audio.preload = 'auto'
    audio.autoplay = false
    audio.muted = false
    audio.volume = this.volume
    ;(audio as any).playsInline = true
    audio.style.display = 'none'
    if (!audio.parentNode && typeof document !== 'undefined') {
      document.body.appendChild(audio)
    }
    return audio
  }

  private attachAudioElement(audio: HTMLAudioElement): void {
    if (this.audioElement === audio) {
      this.ensureAudioElementAttached(audio)
      return
    }
    this.detachAudioElement(false)
    this.audioElement = audio
    this.bindAudioEvents(audio)
    this.ensureAudioElementAttached(audio)
    audio.volume = this.volume
    if (this.currentOutputDeviceId) {
      void this.applyOutputDevice(audio, this.currentOutputDeviceId).catch(() => {})
    }
  }

  private detachAudioElement(clearSrc: boolean): void {
    const audio = this.audioElement
    if (!audio) return
    this.unbindAudioEvents(audio)
    if (clearSrc) {
      try {
        audio.pause()
      } catch (_) {}
      try {
        audio.src = ''
        audio.load()
      } catch (_) {}
    }
    if (audio.parentNode) {
      try {
        audio.parentNode.removeChild(audio)
      } catch (_) {}
    }
    this.audioElement = null
  }

  private ensureAudioElementAttached(audio: HTMLAudioElement): void {
    if (typeof document === 'undefined') return
    if (!audio.parentNode) {
      audio.style.display = 'none'
      document.body.appendChild(audio)
    }
  }

  private bindAudioEvents(audio: HTMLAudioElement): void {
    const handlers = {
      loadedmetadata: () => this.handleMetadataReady(),
      play: () => this.handlePlayEvent(),
      pause: () => this.handlePauseEvent(),
      ended: () => this.handleEndedEvent(),
      error: () => this.handleAudioError()
    }
    audio.addEventListener('loadedmetadata', handlers.loadedmetadata)
    audio.addEventListener('play', handlers.play)
    audio.addEventListener('pause', handlers.pause)
    audio.addEventListener('ended', handlers.ended)
    audio.addEventListener('error', handlers.error)
    this.audioHandlers = handlers
  }

  private unbindAudioEvents(audio: HTMLAudioElement): void {
    const handlers = this.audioHandlers
    if (!handlers) return
    audio.removeEventListener('loadedmetadata', handlers.loadedmetadata)
    audio.removeEventListener('play', handlers.play)
    audio.removeEventListener('pause', handlers.pause)
    audio.removeEventListener('ended', handlers.ended)
    audio.removeEventListener('error', handlers.error)
    this.audioHandlers = null
  }

  private handleMetadataReady(): void {
    if (this.metadataReady) return
    this.metadataReady = true
    const duration = this.getDuration()
    this.emit('decode', duration)
    this.emit('ready')
    if (this.pendingSeekTime !== null) {
      const target = this.pendingSeekTime
      this.pendingSeekTime = null
      this.seek(target, false)
    }
    if (this.pendingPlay) {
      this.pendingPlay = false
      this.startPlayback()
    }
  }

  private startPlayback(): void {
    if (this.mode === 'pcm') {
      this.startPcmPlayback()
      return
    }
    const audio = this.audioElement
    if (!audio) return
    if (!this.metadataReady) {
      this.pendingPlay = true
      return
    }
    if (this.pendingSeekTime !== null) {
      const target = this.pendingSeekTime
      this.pendingSeekTime = null
      try {
        if (typeof (audio as any).fastSeek === 'function') {
          ;(audio as any).fastSeek(target)
        } else {
          audio.currentTime = target
        }
      } catch (_) {}
    }
    if (!audio.paused && !audio.ended) {
      return
    }
    const playPromise = audio.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((error: any) => {
        this.emit('error', error)
      })
    }
  }

  private emitPlayEvent(): void {
    if (this.isPlayingFlag) return
    this.isPlayingFlag = true
    this.emit('play')
    this.startTimeUpdate()
  }

  private emitPauseEvent(): void {
    this.isPlayingFlag = false
    this.stopTimeUpdate()
    this.emit('pause')
  }

  private emitFinishEvent(): void {
    this.isPlayingFlag = false
    this.stopTimeUpdate()
    this.emit('finish')
  }

  private handlePlayEvent(): void {
    this.emitPlayEvent()
  }

  private handlePauseEvent(): void {
    if (this.suppressPauseEvent) {
      this.suppressPauseEvent = false
      return
    }
    this.emitPauseEvent()
  }

  private handleEndedEvent(): void {
    this.suppressPauseEvent = true
    Promise.resolve().then(() => {
      this.suppressPauseEvent = false
    })
    this.emitFinishEvent()
  }

  private handleAudioError(): void {
    this.isPlayingFlag = false
    this.stopTimeUpdate()
    const error = this.audioElement?.error

    // 记录详细的错误信息
    let errorMessage = 'Audio error'
    if (error) {
      const errorCodes: Record<number, string> = {
        1: 'MEDIA_ERR_ABORTED - 加载被中止',
        2: 'MEDIA_ERR_NETWORK - 网络错误',
        3: 'MEDIA_ERR_DECODE - 解码失败',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - 不支持的格式或源'
      }
      errorMessage = errorCodes[error.code] || `未知错误 (code: ${error.code})`
      if (error.message) {
        errorMessage += ` - ${error.message}`
      }
    }

    console.error('[WebAudioPlayer] HTML Audio 错误:', {
      code: error?.code,
      message: error?.message,
      filePath: this.activeFilePath,
      src: this.activeSrc,
      errorMessage
    })

    this.emit('error', new Error(errorMessage))
  }

  private async applyOutputDevice(audio: HTMLAudioElement, deviceId: string): Promise<void> {
    const setSinkId = (audio as any)?.setSinkId
    if (typeof setSinkId !== 'function') {
      throw new Error('setSinkIdUnsupported')
    }
    await setSinkId.call(audio, deviceId)
  }

  private switchToHtml(): void {
    if (this.mode === 'html') return
    this.stopPcmInternal(true)
    this.mode = 'html'
  }

  private switchToPcm(): void {
    if (this.mode === 'pcm') return
    this.stopHtmlInternal(true)
    this.detachAudioElement(true)
    this.mode = 'pcm'
  }

  private ensurePcmContext(sampleRate?: number): AudioContext | null {
    const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) {
      return null
    }

    if (this.pcmContext) {
      if (sampleRate && this.pcmContext.sampleRate !== sampleRate) {
        this.releasePcmContext()
      } else {
        return this.pcmContext
      }
    }

    try {
      this.pcmContext = sampleRate ? new AudioContextCtor({ sampleRate }) : new AudioContextCtor()
    } catch {
      this.pcmContext = null
      return null
    }

    const context = this.pcmContext
    if (!context) {
      return null
    }

    this.pcmGainNode = context.createGain()
    this.pcmGainNode.gain.value = this.volume
    this.pcmGainNode.connect(context.destination)

    if (this.currentOutputDeviceId) {
      void this.applyOutputDeviceToContext(context, this.currentOutputDeviceId).catch(() => {})
    }

    return context
  }

  private releasePcmContext(): void {
    if (this.pcmContext) {
      try {
        void this.pcmContext.close()
      } catch {}
    }
    this.pcmContext = null
    this.pcmGainNode = null
    this.pcmSourceNode = null
  }

  private stopPcmSource(suppressEnded: boolean): void {
    const source = this.pcmSourceNode
    if (!source) return
    if (suppressEnded) {
      this.pcmSuppressEnded = true
    }
    source.onended = null
    try {
      source.stop()
    } catch (_) {}
    this.pcmSourceNode = null
    if (suppressEnded) {
      Promise.resolve().then(() => {
        this.pcmSuppressEnded = false
      })
    }
  }

  private startPcmPlayback(): void {
    if (!this.audioBuffer) {
      this.emit('error', new Error('No audio loaded'))
      return
    }
    const context = this.ensurePcmContext(this.audioBuffer.sampleRate)
    if (!context) {
      this.emit('error', new Error('AudioContext unavailable'))
      return
    }

    if (this.pendingSeekTime !== null) {
      this.pcmOffset = this.pendingSeekTime
      this.pendingSeekTime = null
    }

    const duration = this.getDuration()
    this.pcmOffset =
      duration > 0 ? clampNumber(this.pcmOffset, 0, duration) : Math.max(0, this.pcmOffset)

    this.stopPcmSource(true)
    const source = context.createBufferSource()
    source.buffer = this.audioBuffer
    if (this.pcmGainNode) {
      source.connect(this.pcmGainNode)
    } else {
      source.connect(context.destination)
    }
    source.onended = () => this.handlePcmEnded()
    this.pcmStartTime = context.currentTime - this.pcmOffset
    this.pcmSourceNode = source

    try {
      source.start(0, this.pcmOffset)
    } catch (error: any) {
      this.emit('error', error)
      return
    }

    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }

    this.emitPlayEvent()
  }

  private pausePcm(): void {
    if (!this.audioBuffer) return
    if (!this.isPlayingFlag) return
    this.pcmOffset = this.getPcmCurrentTime()
    this.stopPcmSource(true)
    this.emitPauseEvent()
  }

  private seekPcm(time: number, manual: boolean): void {
    const duration = this.getDuration()
    const nextTime = duration > 0 ? clampNumber(time, 0, duration) : Math.max(0, time)

    if (!this.metadataReady) {
      this.pendingSeekTime = nextTime
      this.emit('seeked', { time: nextTime, manual })
      return
    }

    const wasPlaying = this.isPlayingFlag
    this.pcmOffset = nextTime
    if (wasPlaying) {
      this.stopPcmSource(true)
      this.startPcmPlayback()
    }

    this.emit('seeked', { time: nextTime, manual })
    if (!wasPlaying) {
      this.emit('timeupdate', nextTime)
    }
  }

  private getPcmCurrentTime(): number {
    if (!this.audioBuffer) return 0
    if (!this.isPlayingFlag) {
      return Number.isFinite(this.pcmOffset) ? this.pcmOffset : 0
    }
    const context = this.pcmContext
    if (!context) {
      return Number.isFinite(this.pcmOffset) ? this.pcmOffset : 0
    }
    const current = context.currentTime - this.pcmStartTime
    const duration = this.getDuration()
    return duration > 0 ? clampNumber(current, 0, duration) : Math.max(0, current)
  }

  private handlePcmEnded(): void {
    if (this.pcmSuppressEnded) {
      return
    }
    this.pcmSourceNode = null
    this.pcmOffset = this.getDuration()
    this.emitFinishEvent()
  }

  private async applyOutputDeviceToContext(context: AudioContext, deviceId: string): Promise<void> {
    const setSinkId = (context as any)?.setSinkId
    if (typeof setSinkId !== 'function') {
      throw new Error('setSinkIdUnsupported')
    }
    await setSinkId.call(context, deviceId)
  }
}
