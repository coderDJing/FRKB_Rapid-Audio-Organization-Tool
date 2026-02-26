import { applyMixxxTransportSync } from '@renderer/composables/mixtape/timelineTransportSync'

export type MixtapeOutputProgressPayload = {
  stageKey: string
  done: number
  total: number
  percent: number
}

export type MixtapeRenderedWavResult = {
  wavBytes: Uint8Array
  durationSec: number
  sampleRate: number
  channels: number
  trackCount: number
}

type TransportEntry = {
  trackId: string
  filePath: string
  startSec: number
  duration: number
  sourceDuration: number
  tempoRatio: number
  audioBuffer: AudioBuffer | null
  decodeMode: 'browser' | 'ipc'
}

type TrackGraphNode = {
  trackId: string
  entry: TransportEntry
  source: AudioBufferSourceNode
  eqHigh: BiquadFilterNode
  eqMid: BiquadFilterNode
  eqLow: BiquadFilterNode
  volume: GainNode
  gain: GainNode
}

export const createTimelineTransportRenderWavModule = (ctx: any) => {
  const {
    t,
    buildTransportEntries,
    readTransportBufferCache,
    ensureDecodedEntry,
    getTransportAudioContext,
    clampNumber,
    resolveEntryEqDbValue,
    resolveEntryEnvelopeValue,
    applyTransportMixParamsAtTimelineSec
  } = ctx

  const SCHEDULING_PROGRESS_STEP = 20
  const SCHEDULING_YIELD_INTERVAL_MS = 12
  const WAV_ENCODE_CHUNK_FRAMES = 8192
  const WAV_ENCODE_YIELD_INTERVAL_MS = 12

  const getNowMs = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()

  const yieldMainThread = async () => {
    await new Promise<void>((resolve) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve())
        return
      }
      setTimeout(() => resolve(), 0)
    })
  }

  const resolveOutputChannels = (_entries: TransportEntry[]) => 2

  const resolveOutputSampleRate = (entries: TransportEntry[]) => {
    const activeTransportSampleRate = Number(getTransportAudioContext()?.sampleRate || 0)
    if (Number.isFinite(activeTransportSampleRate) && activeTransportSampleRate > 0) {
      return activeTransportSampleRate
    }
    for (const entry of entries) {
      const sampleRate = Number(entry.audioBuffer?.sampleRate || 0)
      if (Number.isFinite(sampleRate) && sampleRate > 0) {
        return sampleRate
      }
    }
    try {
      const context = new AudioContext()
      const sampleRate = Number(context.sampleRate) || 44100
      void context.close().catch(() => {})
      return sampleRate
    } catch {
      return 44100
    }
  }

  const writeWavText = (view: DataView, offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  const encodeAudioBufferToWav = async (
    audioBuffer: AudioBuffer,
    channels: number,
    options?: {
      onProgress?: (doneFrames: number, totalFrames: number) => void
    }
  ): Promise<Uint8Array> => {
    const sourceChannels = Math.max(1, Math.floor(audioBuffer.numberOfChannels || 1))
    const outputChannels = Math.max(1, Math.min(2, Math.floor(channels || sourceChannels)))
    const frameCount = Math.max(0, Math.floor(audioBuffer.length || 0))
    const sampleRate = Math.max(1, Math.floor(audioBuffer.sampleRate || 44100))
    const bytesPerSample = 2
    const blockAlign = outputChannels * bytesPerSample
    const dataSize = frameCount * blockAlign
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)

    writeWavText(view, 0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeWavText(view, 8, 'WAVE')
    writeWavText(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, outputChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, bytesPerSample * 8, true)
    writeWavText(view, 36, 'data')
    view.setUint32(40, dataSize, true)

    const channelData: Float32Array[] = []
    for (let channelIndex = 0; channelIndex < sourceChannels; channelIndex += 1) {
      channelData.push(audioBuffer.getChannelData(channelIndex))
    }

    let writeOffset = 44
    let frameIndex = 0
    let lastYieldAt = getNowMs()
    while (frameIndex < frameCount) {
      const chunkEnd = Math.min(frameCount, frameIndex + WAV_ENCODE_CHUNK_FRAMES)
      for (; frameIndex < chunkEnd; frameIndex += 1) {
        for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
          const sourceIndex = sourceChannels === 1 ? 0 : Math.min(sourceChannels - 1, channelIndex)
          const sample = channelData[sourceIndex]?.[frameIndex] ?? 0
          const clamped = clampNumber(sample, -1, 1)
          const int16Value =
            clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
          view.setInt16(writeOffset, int16Value, true)
          writeOffset += 2
        }
      }
      options?.onProgress?.(frameIndex, frameCount)
      if (frameIndex >= frameCount) break
      if (getNowMs() - lastYieldAt < WAV_ENCODE_YIELD_INTERVAL_MS) continue
      await yieldMainThread()
      lastYieldAt = getNowMs()
    }
    if (frameCount <= 0) {
      options?.onProgress?.(0, 0)
    }
    return new Uint8Array(buffer)
  }

  const scheduleOfflineAutomation = async (params: {
    nodes: TrackGraphNode[]
    durationSec: number
    offlineCtx: OfflineAudioContext
    emitProgress: (payload: MixtapeOutputProgressPayload) => void
  }) => {
    const { nodes, durationSec, offlineCtx, emitProgress } = params
    let masterTrackId = ''
    const stepSec = 1 / 120
    const totalSteps = Math.max(1, Math.ceil(durationSec / stepSec))
    const schedulingNodes = nodes as any[]
    let lastYieldAt = getNowMs()
    for (let step = 0; step <= totalSteps; step += 1) {
      const timelineSec = Math.min(durationSec, step * stepSec)
      applyTransportMixParamsAtTimelineSec(timelineSec, {
        nodes,
        audioCtx: offlineCtx,
        automationAtSec: timelineSec
      })
      const syncResult = applyMixxxTransportSync({
        nodes: schedulingNodes,
        timelineSec,
        masterTrackId,
        audioCtx: offlineCtx
      })
      masterTrackId = syncResult.masterTrackId
      if (step % SCHEDULING_PROGRESS_STEP === 0 || step === totalSteps) {
        emitProgress({
          stageKey: 'mixtape.outputProgressScheduling',
          done: step,
          total: totalSteps,
          percent: Math.round(42 + (step / Math.max(1, totalSteps)) * 26)
        })
      }
      if (step >= totalSteps) continue
      if (getNowMs() - lastYieldAt < SCHEDULING_YIELD_INTERVAL_MS) continue
      await yieldMainThread()
      lastYieldAt = getNowMs()
    }
  }

  const emitEncodeProgress = (
    emitProgress: (payload: MixtapeOutputProgressPayload) => void,
    doneFrames: number,
    totalFrames: number,
    lastPercentRef: { value: number }
  ) => {
    const ratio = totalFrames > 0 ? doneFrames / Math.max(1, totalFrames) : 1
    const percent = Math.round(93 + clampNumber(ratio, 0, 1) * 2)
    if (percent <= lastPercentRef.value) return
    lastPercentRef.value = percent
    emitProgress({
      stageKey: 'mixtape.outputProgressEncoding',
      done: percent,
      total: 100,
      percent
    })
  }

  const buildOutputTrackNodes = (
    offlineCtx: OfflineAudioContext,
    entries: TransportEntry[]
  ): TrackGraphNode[] => {
    const nodes: TrackGraphNode[] = []
    for (const entry of entries) {
      if (!entry.audioBuffer) continue
      const source = offlineCtx.createBufferSource()
      source.buffer = entry.audioBuffer
      source.playbackRate.value = entry.tempoRatio

      const eqLow = offlineCtx.createBiquadFilter()
      eqLow.type = 'lowshelf'
      eqLow.frequency.value = 220

      const eqMid = offlineCtx.createBiquadFilter()
      eqMid.type = 'peaking'
      eqMid.frequency.value = 1000
      eqMid.Q.value = 0.9

      const eqHigh = offlineCtx.createBiquadFilter()
      eqHigh.type = 'highshelf'
      eqHigh.frequency.value = 3200

      const volume = offlineCtx.createGain()
      const gain = offlineCtx.createGain()

      const initialTimelineSec = 0
      const initialLocalSec = Math.max(0, initialTimelineSec - entry.startSec)
      eqHigh.gain.value = resolveEntryEqDbValue(entry, 'high', initialLocalSec)
      eqMid.gain.value = resolveEntryEqDbValue(entry, 'mid', initialLocalSec)
      eqLow.gain.value = resolveEntryEqDbValue(entry, 'low', initialLocalSec)
      volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', initialLocalSec)
      gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', initialLocalSec)

      source.connect(eqLow)
      eqLow.connect(eqMid)
      eqMid.connect(eqHigh)
      eqHigh.connect(volume)
      volume.connect(gain)
      gain.connect(offlineCtx.destination)
      source.start(entry.startSec, 0)

      nodes.push({
        trackId: entry.trackId,
        entry,
        source,
        eqHigh,
        eqMid,
        eqLow,
        volume,
        gain
      })
    }
    return nodes
  }

  const renderMixtapeOutputWav = async (options?: {
    onProgress?: (payload: MixtapeOutputProgressPayload) => void
  }): Promise<MixtapeRenderedWavResult> => {
    const emitProgress = (payload: MixtapeOutputProgressPayload) => {
      options?.onProgress?.(payload)
    }
    emitProgress({
      stageKey: 'mixtape.outputProgressPreparing',
      done: 1,
      total: 100,
      percent: 1
    })

    const plan = buildTransportEntries()
    const entries = plan.entries as TransportEntry[]
    if (!entries.length) {
      throw new Error(t('mixtape.outputNoTracks'))
    }
    if (plan.missingDurationCount > 0) {
      throw new Error(t('mixtape.transportMissingDuration', { count: plan.missingDurationCount }))
    }

    const decodeQueue: TransportEntry[] = []
    for (const entry of entries) {
      const cached = readTransportBufferCache(entry.filePath)
      if (cached) {
        entry.audioBuffer = cached
        continue
      }
      decodeQueue.push(entry)
    }
    const decodeTotal = Math.max(1, decodeQueue.length)
    emitProgress({
      stageKey: 'mixtape.outputProgressDecoding',
      done: 0,
      total: decodeTotal,
      percent: 5
    })
    if (decodeQueue.length > 0) {
      let decodeDone = 0
      const workerCount = Math.max(1, Math.min(3, decodeQueue.length))
      let cursor = 0
      let failCount = 0
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = cursor
          cursor += 1
          if (currentIndex >= decodeQueue.length) return
          const entry = decodeQueue[currentIndex]
          try {
            await ensureDecodedEntry(entry)
          } catch (error) {
            console.error('[mixtape-output] decode failed:', entry.filePath, error)
            failCount += 1
          } finally {
            decodeDone += 1
            emitProgress({
              stageKey: 'mixtape.outputProgressDecoding',
              done: decodeDone,
              total: decodeTotal,
              percent: Math.round(5 + (decodeDone / decodeTotal) * 35)
            })
          }
        }
      })
      await Promise.all(workers)
      if (failCount > 0) {
        throw new Error(t('mixtape.transportDecodeFailed', { count: failCount }))
      }
    }

    for (const entry of entries) {
      if (!entry.audioBuffer) {
        throw new Error(t('mixtape.transportDecodeFailed', { count: 1 }))
      }
    }
    const playableEntries = entries.filter((entry) => !!entry.audioBuffer)
    const durationSec = playableEntries.reduce(
      (max, entry) => Math.max(max, entry.startSec + entry.duration),
      0
    )
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(t('mixtape.transportNoPlayableTracks'))
    }

    const sampleRate = resolveOutputSampleRate(playableEntries)
    const outputChannels = resolveOutputChannels(playableEntries)
    const frameCount = Math.max(1, Math.ceil(durationSec * sampleRate))
    const offlineCtx = new OfflineAudioContext(outputChannels, frameCount, sampleRate)
    const nodes = buildOutputTrackNodes(offlineCtx, playableEntries)

    emitProgress({
      stageKey: 'mixtape.outputProgressScheduling',
      done: 0,
      total: 100,
      percent: 42
    })
    await scheduleOfflineAutomation({
      nodes,
      durationSec,
      offlineCtx,
      emitProgress
    })

    emitProgress({
      stageKey: 'mixtape.outputProgressRendering',
      done: 0,
      total: 100,
      percent: 70
    })
    let renderPercent = 70
    const renderTicker = setInterval(() => {
      renderPercent = Math.min(92, renderPercent + 1)
      emitProgress({
        stageKey: 'mixtape.outputProgressRendering',
        done: renderPercent,
        total: 100,
        percent: renderPercent
      })
    }, 160)
    let renderedBuffer: AudioBuffer | null = null
    try {
      renderedBuffer = await offlineCtx.startRendering()
    } finally {
      clearInterval(renderTicker)
    }
    if (!renderedBuffer) {
      throw new Error(t('mixtape.outputProgressFailed'))
    }

    emitProgress({
      stageKey: 'mixtape.outputProgressEncoding',
      done: 93,
      total: 100,
      percent: 93
    })
    const lastEncodePercentRef = { value: 93 }
    const wavBytes = await encodeAudioBufferToWav(renderedBuffer, outputChannels, {
      onProgress: (doneFrames, totalFrames) =>
        emitEncodeProgress(emitProgress, doneFrames, totalFrames, lastEncodePercentRef)
    })
    emitProgress({
      stageKey: 'mixtape.outputProgressEncoding',
      done: Math.max(94, lastEncodePercentRef.value),
      total: 100,
      percent: Math.max(94, lastEncodePercentRef.value)
    })

    return {
      wavBytes,
      durationSec,
      sampleRate: renderedBuffer.sampleRate,
      channels: outputChannels,
      trackCount: playableEntries.length
    }
  }

  return {
    renderMixtapeOutputWav
  }
}
