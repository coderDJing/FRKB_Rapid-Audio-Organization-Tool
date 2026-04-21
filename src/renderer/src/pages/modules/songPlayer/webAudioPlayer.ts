import mitt from 'mitt'
import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import { t } from '@renderer/utils/translate'
import { configureTitleAudioVisualizerAnalyser } from '@renderer/composables/titleAudioVisualizerBridge'
import {
  canPlayHtmlAudio,
  clampNumber,
  getErrorLike,
  isEmptySourceAudioErrorMessage,
  isIgnorablePlayInterruptionError,
  normalizePcmData,
  toPreviewUrl
} from './webAudioPlayer.shared'
import type {
  AudioContextConstructor,
  AudioContextWithExtensions,
  AudioElementWithExtensions,
  PcmLoadPayload,
  WebAudioPlayerEvents,
  WindowWithAudioContext,
  MixxxWaveformData,
  MixxxWaveformBand,
  MixxxWaveformBandKey,
  RGBWaveformBandKey,
  SeekedEventPayload,
  WaveformStyle
} from './webAudioPlayer.shared'

export { canPlayHtmlAudio, toPreviewUrl } from './webAudioPlayer.shared'
export type {
  MixxxWaveformData,
  MixxxWaveformBand,
  MixxxWaveformBandKey,
  PcmLoadPayload,
  RGBWaveformBandKey,
  SeekedEventPayload,
  WaveformStyle,
  WebAudioPlayerEvents
} from './webAudioPlayer.shared'

export class WebAudioPlayer {
  public audioBuffer: AudioBuffer | null = null
  public mixxxWaveformData: MixxxWaveformData | null = null
  public pioneerPreviewWaveformData: IPioneerPreviewWaveformData | null = null
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
  private ignoreNextEmptySourceError = false
  private mode: 'none' | 'html' | 'pcm' = 'none'
  private visualizerAnalyserNode: AnalyserNode | null = null

  private audioElement: AudioElementWithExtensions | null = null
  private audioHandlers: {
    loadedmetadata: () => void
    play: () => void
    pause: () => void
    ended: () => void
    error: () => void
  } | null = null
  private htmlAnalysisContext: AudioContext | null = null
  private htmlAnalysisAudioElement: AudioElementWithExtensions | null = null
  private htmlAnalysisSourceNode: MediaElementAudioSourceNode | null = null
  private htmlAnalysisAnalyserNode: AnalyserNode | null = null
  private htmlOutputGainNode: GainNode | null = null

  private pcmContext: AudioContext | null = null
  private pcmGainNode: GainNode | null = null
  private pcmAnalyserNode: AnalyserNode | null = null
  private pcmSourceNode: AudioBufferSourceNode | null = null
  private pcmOffset = 0
  private pcmStartTime = 0
  private pcmDuration = 0
  private pcmSuppressEnded = false

  on<K extends keyof WebAudioPlayerEvents>(
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ): void {
    this.emitter.on(event, handler)
  }

  off<K extends keyof WebAudioPlayerEvents>(
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ): void {
    this.emitter.off(event, handler)
  }

  once<K extends keyof WebAudioPlayerEvents>(
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ): void {
    const wrapper = (payload: WebAudioPlayerEvents[K]) => {
      this.off(event, wrapper)
      handler(payload)
    }
    this.on(event, wrapper)
  }

  private emit<K extends keyof WebAudioPlayerEvents>(
    event: K,
    payload?: WebAudioPlayerEvents[K]
  ): void {
    this.emitter.emit(event, payload as WebAudioPlayerEvents[K])
  }

  removeAllListeners<K extends keyof WebAudioPlayerEvents>(event?: K): void {
    const all = this.emitter.all
    if (event) {
      all.delete(event)
    } else if (all.clear) {
      all.clear()
    }
  }

  getVisualizerAnalyser(): AnalyserNode | null {
    return this.visualizerAnalyserNode
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

  suppressNextEmptySourceError(): void {
    this.ignoreNextEmptySourceError = true
  }

  loadFile(filePath: string): void {
    const normalized = (filePath || '').trim()
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
    this.releasePioneerPreviewWaveformData()

    const audio = this.createAudioElement()
    this.attachAudioElement(audio)

    const src = toPreviewUrl(normalized)
    this.activeFilePath = normalized
    this.activeSrc = src

    const sourceChanged = audio.src !== src
    if (sourceChanged) {
      audio.src = src
    }
    audio.preload = 'auto'
    audio.autoplay = false
    audio.muted = false
    audio.volume = this.volume
    if (sourceChanged) {
      try {
        audio.load()
      } catch (error) {
        this.emit('error', error)
      }
    }
    this.ensureHtmlAnalysis(audio)

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
    this.releasePioneerPreviewWaveformData()

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
    if (this.mode === 'html' && this.htmlOutputGainNode) {
      this.htmlOutputGainNode.gain.value = this.volume
      return
    }
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
      if (typeof audio.fastSeek === 'function') {
        audio.fastSeek(nextTime)
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
    this.releasePioneerPreviewWaveformData()
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
    this.releasePioneerPreviewWaveformData()
    this.mixxxWaveformData = data
    if (filePath) {
      this.mixxxWaveformFilePath = filePath
      this.mixxxWaveformBytes = this.calculateMixxxWaveformBytes(data)
    }
    this.emit('mixxxwaveformready')
  }

  setPioneerPreviewWaveformData(data: IPioneerPreviewWaveformData | null): void {
    if (!data) {
      this.releasePioneerPreviewWaveformData()
      return
    }
    this.releaseMixxxWaveformData()
    this.pioneerPreviewWaveformData = data
    this.emit('mixxxwaveformready')
  }

  private releaseMixxxWaveformData(): void {
    if (this.mixxxWaveformFilePath) {
      this.mixxxWaveformFilePath = null
      this.mixxxWaveformBytes = 0
    }
    this.mixxxWaveformData = null
  }

  private releasePioneerPreviewWaveformData(): void {
    this.pioneerPreviewWaveformData = null
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
    this.releaseHtmlAnalysis()
    this.releasePcmContext()
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const normalized = deviceId || ''
    if (normalized === this.currentOutputDeviceId) {
      return
    }
    this.currentOutputDeviceId = normalized
    if (this.mode === 'pcm' || this.mode === 'html') {
      const context = this.mode === 'pcm' ? this.pcmContext : this.htmlAnalysisContext
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
    const setSinkId = audio.setSinkId
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

  private createAudioElement(): AudioElementWithExtensions {
    const audio = document.createElement('audio') as AudioElementWithExtensions
    audio.preload = 'auto'
    audio.autoplay = false
    audio.muted = false
    audio.crossOrigin = 'anonymous'
    audio.volume = this.volume
    audio.setAttribute('playsinline', 'true')
    audio.style.display = 'none'
    if (!audio.parentNode && typeof document !== 'undefined') {
      document.body.appendChild(audio)
    }
    return audio
  }

  private attachAudioElement(audio: AudioElementWithExtensions): void {
    if (this.audioElement === audio) {
      this.ensureAudioElementAttached(audio)
      return
    }
    this.detachAudioElement(false)
    this.audioElement = audio
    this.bindAudioEvents(audio)
    this.ensureAudioElementAttached(audio)
    audio.volume = this.volume
  }

  private detachAudioElement(clearSrc: boolean): void {
    const audio = this.audioElement
    if (!audio) return
    this.releaseHtmlAnalysis()
    this.unbindAudioEvents(audio)
    if (clearSrc) {
      this.suppressNextEmptySourceError()
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

  private ensureAudioElementAttached(audio: AudioElementWithExtensions): void {
    if (typeof document === 'undefined') return
    if (!audio.parentNode) {
      audio.style.display = 'none'
      document.body.appendChild(audio)
    }
  }

  private bindAudioEvents(audio: AudioElementWithExtensions): void {
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

  private unbindAudioEvents(audio: AudioElementWithExtensions): void {
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
        if (typeof audio.fastSeek === 'function') {
          audio.fastSeek(target)
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
      playPromise.catch((error: unknown) => {
        if (isEmptySourceAudioErrorMessage(getErrorLike(error)?.message || error)) {
          return
        }
        if (this.consumeIgnoredEmptySourceError(error)) {
          return
        }
        if (isIgnorablePlayInterruptionError(error)) {
          return
        }
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
    this.resumeHtmlAnalysisContext()
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
    if (isEmptySourceAudioErrorMessage(error?.message)) {
      return
    }
    if (this.consumeIgnoredEmptySourceError(error?.message)) {
      return
    }

    // 记录详细的错误信息
    let errorMessage = 'Audio error'
    if (error) {
      const errorCodes: Record<number, string> = {
        1: t('player.audioErrorAborted'),
        2: t('player.audioErrorNetwork'),
        3: t('player.audioErrorDecode'),
        4: t('player.audioErrorSourceNotSupported')
      }
      errorMessage =
        errorCodes[error.code] || t('player.audioErrorUnknownWithCode', { code: error.code })
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

  private consumeIgnoredEmptySourceError(errorLike: unknown): boolean {
    if (!this.ignoreNextEmptySourceError) return false
    if (!isEmptySourceAudioErrorMessage(errorLike)) return false
    this.ignoreNextEmptySourceError = false
    return true
  }

  private async applyOutputDevice(
    audio: AudioElementWithExtensions,
    deviceId: string
  ): Promise<void> {
    const setSinkId = audio.setSinkId
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

  private setVisualizerAnalyserNode(analyser: AnalyserNode | null): void {
    this.visualizerAnalyserNode = analyser
  }

  private resolveAudioContextConstructor(): AudioContextConstructor | null {
    const windowWithAudio = window as WindowWithAudioContext
    return windowWithAudio.AudioContext || windowWithAudio.webkitAudioContext || null
  }

  private createAudioContext(options?: AudioContextOptions): AudioContext | null {
    const AudioContextCtor = this.resolveAudioContextConstructor()
    if (!AudioContextCtor) {
      return null
    }
    try {
      return options ? new AudioContextCtor(options) : new AudioContextCtor()
    } catch {
      return null
    }
  }

  private ensureHtmlAnalysis(audio: AudioElementWithExtensions): void {
    if (this.mode !== 'html') return
    if (this.htmlAnalysisAudioElement === audio && this.htmlAnalysisAnalyserNode) {
      this.setVisualizerAnalyserNode(this.htmlAnalysisAnalyserNode)
      return
    }

    this.releaseHtmlAnalysis()
    const context = this.createAudioContext()
    if (!context) {
      this.setVisualizerAnalyserNode(null)
      return
    }

    try {
      const source = context.createMediaElementSource(audio)
      const analyser = configureTitleAudioVisualizerAnalyser(context.createAnalyser())
      const outputGain = context.createGain()
      outputGain.gain.value = this.volume
      source.connect(analyser)
      analyser.connect(outputGain)
      outputGain.connect(context.destination)

      this.htmlAnalysisContext = context
      this.htmlAnalysisAudioElement = audio
      this.htmlAnalysisSourceNode = source
      this.htmlAnalysisAnalyserNode = analyser
      this.htmlOutputGainNode = outputGain
      this.setVisualizerAnalyserNode(analyser)
      audio.volume = 1
      if (this.currentOutputDeviceId) {
        void this.applyOutputDeviceToContext(context, this.currentOutputDeviceId).catch(() => {})
      }
    } catch {
      try {
        void context.close()
      } catch {}
      this.setVisualizerAnalyserNode(null)
    }
  }

  private resumeHtmlAnalysisContext(): void {
    const context = this.htmlAnalysisContext
    if (!context || context.state !== 'suspended') {
      return
    }
    void context.resume().catch(() => {})
  }

  private releaseHtmlAnalysis(): void {
    try {
      this.htmlAnalysisSourceNode?.disconnect()
    } catch {}
    try {
      this.htmlAnalysisAnalyserNode?.disconnect()
    } catch {}
    try {
      this.htmlOutputGainNode?.disconnect()
    } catch {}
    if (this.htmlAnalysisContext && this.htmlAnalysisContext.state !== 'closed') {
      try {
        void this.htmlAnalysisContext.close()
      } catch {}
    }
    this.htmlAnalysisContext = null
    this.htmlAnalysisAudioElement = null
    this.htmlAnalysisSourceNode = null
    this.htmlAnalysisAnalyserNode = null
    this.htmlOutputGainNode = null
    if (this.mode !== 'pcm') {
      this.setVisualizerAnalyserNode(null)
    }
  }

  private ensurePcmContext(sampleRate?: number): AudioContext | null {
    if (this.pcmContext) {
      if (sampleRate && this.pcmContext.sampleRate !== sampleRate) {
        this.releasePcmContext()
      } else {
        return this.pcmContext
      }
    }

    this.pcmContext = this.createAudioContext(sampleRate ? { sampleRate } : undefined)
    if (!this.pcmContext) {
      this.pcmContext = null
      return null
    }

    const context = this.pcmContext
    if (!context) {
      return null
    }

    this.pcmGainNode = context.createGain()
    this.pcmAnalyserNode = configureTitleAudioVisualizerAnalyser(context.createAnalyser())
    this.pcmGainNode.gain.value = this.volume
    this.pcmAnalyserNode.connect(this.pcmGainNode)
    this.pcmGainNode.connect(context.destination)
    this.setVisualizerAnalyserNode(this.pcmAnalyserNode)

    if (this.currentOutputDeviceId) {
      void this.applyOutputDeviceToContext(context, this.currentOutputDeviceId).catch(() => {})
    }

    return context
  }

  private releasePcmContext(): void {
    try {
      this.pcmGainNode?.disconnect()
    } catch {}
    try {
      this.pcmAnalyserNode?.disconnect()
    } catch {}
    if (this.pcmContext) {
      try {
        void this.pcmContext.close()
      } catch {}
    }
    this.pcmContext = null
    this.pcmGainNode = null
    this.pcmAnalyserNode = null
    this.pcmSourceNode = null
    this.setVisualizerAnalyserNode(this.mode === 'html' ? this.htmlAnalysisAnalyserNode : null)
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
    if (this.pcmAnalyserNode) {
      source.connect(this.pcmAnalyserNode)
    } else if (this.pcmGainNode) {
      source.connect(this.pcmGainNode)
    } else {
      source.connect(context.destination)
    }
    source.onended = () => this.handlePcmEnded()
    this.pcmStartTime = context.currentTime - this.pcmOffset
    this.pcmSourceNode = source

    try {
      source.start(0, this.pcmOffset)
    } catch (error: unknown) {
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
    const extendedContext = context as AudioContextWithExtensions
    const setSinkId = extendedContext.setSinkId
    if (typeof setSinkId !== 'function') {
      throw new Error('setSinkIdUnsupported')
    }
    await setSinkId.call(extendedContext, deviceId)
  }
}
