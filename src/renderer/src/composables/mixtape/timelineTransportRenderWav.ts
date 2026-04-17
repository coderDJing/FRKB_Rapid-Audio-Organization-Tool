import { applyMixxxTransportSync } from '@renderer/composables/mixtape/timelineTransportSync'
import {
  createTransportBufferSource,
  createTransportKeyLockSource,
  ensureTransportKeyLockWorkletModule,
  type TransportPlayableAudioContext,
  type TransportPlayableSource
} from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import { processMixtapeAudioBufferWithSoundTouch } from '@renderer/composables/mixtape/mixtapeSoundTouch'
import type { TransportSyncNode } from '@renderer/composables/mixtape/timelineTransportSync'
import type { MixtapeEnvelopeParamId } from '@renderer/composables/mixtape/types'
import type {
  TransportEntry,
  TransportAudioRef,
  TransportStemAudioRef,
  TransportStemId
} from '@renderer/composables/mixtape/timelineTransportAudioData'
import type {
  TrackGraphNode,
  TrackStemGraphNode
} from '@renderer/composables/mixtape/timelineTransportPlaybackNodes'

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

type RenderTransportEntry = TransportEntry & {
  soundTouchRendered?: boolean
}

type TimelineTransportRenderWavCtx = {
  t: (key: string, payload?: Record<string, unknown>) => string
  buildTransportEntries: () => {
    entries: RenderTransportEntry[]
    missingDurationCount: number
    stemNotReadyCount: number
    missingStemAssetCount: number
    decodeFailedCount: number
  }
  readTransportBufferCache: (filePath: string) => AudioBuffer | null
  ensureDecodedTransportEntry: (entry: TransportEntry) => Promise<void>
  ensureDecodedStemAudio?: unknown
  getTransportAudioContext: () => AudioContext | null
  clampNumber: (value: number, min: number, max: number) => number
  resolveEntryEqDbValue: (
    entry: TransportEntry,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => number
  resolveEntryEnvelopeValue: (
    entry: TransportEntry,
    param: MixtapeEnvelopeParamId,
    timelineOffsetSec: number
  ) => number
  isStemMode: () => boolean
  applyTransportMixParamsAtTimelineSec: (
    timelineSec: number,
    options?: {
      nodes?: TrackGraphNode[]
      audioCtx?: BaseAudioContext | null
      automationAtSec?: number
    }
  ) => void
  resolveStemIdsForMode: () => TransportStemId[]
  mirrorTransportStemPlaybackRates: (
    nodes: TrackGraphNode[],
    audioCtx: BaseAudioContext | null,
    automationAtSec?: number
  ) => void
}

export const createTimelineTransportRenderWavModule = (ctx: TimelineTransportRenderWavCtx) => {
  const {
    t,
    buildTransportEntries,
    readTransportBufferCache,
    ensureDecodedTransportEntry,
    getTransportAudioContext,
    clampNumber,
    resolveEntryEqDbValue,
    resolveEntryEnvelopeValue,
    isStemMode,
    applyTransportMixParamsAtTimelineSec,
    resolveStemIdsForMode,
    mirrorTransportStemPlaybackRates
  } = ctx

  const SCHEDULING_PROGRESS_STEP = 20
  const SCHEDULING_YIELD_INTERVAL_MS = 12
  const WAV_ENCODE_CHUNK_FRAMES = 8192
  const WAV_ENCODE_YIELD_INTERVAL_MS = 12
  const isStemMixMode = (): boolean => Boolean(isStemMode?.())
  const resolveStemIds = (): TransportStemId[] => resolveStemIdsForMode() as TransportStemId[]

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

  const resolveOutputChannels = (_entries: RenderTransportEntry[]) => 2

  const resolveOutputSampleRate = (entries: RenderTransportEntry[]) => {
    const activeTransportSampleRate = Number(getTransportAudioContext()?.sampleRate || 0)
    if (Number.isFinite(activeTransportSampleRate) && activeTransportSampleRate > 0) {
      return activeTransportSampleRate
    }
    for (const entry of entries) {
      if (isStemMixMode()) {
        for (const stemId of resolveStemIds()) {
          const sampleRate = Number(entry.stemAudioById?.[stemId]?.audioBuffer?.sampleRate || 0)
          if (Number.isFinite(sampleRate) && sampleRate > 0) {
            return sampleRate
          }
        }
      } else {
        const sampleRate = Number(entry.audioRef?.audioBuffer?.sampleRate || 0)
        if (Number.isFinite(sampleRate) && sampleRate > 0) {
          return sampleRate
        }
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
    timelineOriginSec: number
    offlineCtx: OfflineAudioContext
    emitProgress: (payload: MixtapeOutputProgressPayload) => void
  }) => {
    const { nodes, durationSec, timelineOriginSec, offlineCtx, emitProgress } = params
    let masterTrackId = ''
    const stepSec = 1 / 120
    const totalSteps = Math.max(1, Math.ceil(durationSec / stepSec))
    const schedulingNodes = nodes as unknown as TransportSyncNode[]
    let lastYieldAt = getNowMs()
    for (let step = 0; step <= totalSteps; step += 1) {
      const renderSec = Math.min(durationSec, step * stepSec)
      const timelineSec = timelineOriginSec + renderSec
      applyTransportMixParamsAtTimelineSec(timelineSec, {
        nodes,
        audioCtx: offlineCtx,
        automationAtSec: renderSec
      })
      const syncResult = applyMixxxTransportSync({
        nodes: schedulingNodes,
        timelineSec,
        masterTrackId,
        audioCtx: offlineCtx
      })
      masterTrackId = syncResult.masterTrackId
      mirrorTransportStemPlaybackRates(nodes, offlineCtx, timelineSec)
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
    entries: RenderTransportEntry[],
    timelineOriginSec: number,
    useRealtimeKeyLock: boolean
  ): TrackGraphNode[] => {
    const nodes: TrackGraphNode[] = []
    const useStemMode = isStemMixMode()
    const stemIds = resolveStemIds()
    for (const entry of entries) {
      if (useStemMode) {
        const stemAudios = stemIds
          .map((stemId) => entry.stemAudioById?.[stemId])
          .filter((item): item is TransportStemAudioRef => !!item && !!item.audioBuffer)
        if (!stemAudios.length) continue
        const stemBus = offlineCtx.createGain()
        const volume = offlineCtx.createGain()
        const gain = offlineCtx.createGain()

        const initialTimelineSec = timelineOriginSec
        const initialLocalSec = Math.max(0, initialTimelineSec - entry.startSec)
        volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', initialLocalSec)
        gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', initialLocalSec)
        stemBus.gain.value = 1
        stemBus.connect(volume)
        volume.connect(gain)
        gain.connect(offlineCtx.destination)

        const stemNodes: TrackStemGraphNode[] = []
        for (const stemAudio of stemAudios) {
          const source =
            useRealtimeKeyLock && entry.masterTempo
              ? createTransportKeyLockSource(
                  offlineCtx as TransportPlayableAudioContext,
                  stemAudio.audioBuffer as AudioBuffer
                )
              : createTransportBufferSource(
                  offlineCtx as TransportPlayableAudioContext,
                  stemAudio.audioBuffer as AudioBuffer
                )
          source.playbackRate.value = entry.soundTouchRendered ? 1 : entry.tempoRatio
          const stemGain = offlineCtx.createGain()
          stemGain.gain.value = resolveEntryEnvelopeValue(entry, stemAudio.stemId, initialLocalSec)
          source.connect(stemGain)
          stemGain.connect(stemBus)
          source.start(
            Math.max(0, entry.startSec - timelineOriginSec),
            entry.soundTouchRendered
              ? Math.max(0, Number(entry.baseLocalStartSec) || 0)
              : Math.max(0, Number(entry.sourceOffsetSec) || 0)
          )
          source.stop(
            Math.max(0, entry.startSec - timelineOriginSec) +
              Math.max(0.02, Number(entry.duration) || 0) +
              0.02
          )
          stemNodes.push({
            stemId: stemAudio.stemId,
            source,
            stemGain
          })
        }
        const primaryStemNode = stemNodes[0]
        if (!primaryStemNode) continue

        nodes.push({
          trackId: entry.trackId,
          entry,
          source: primaryStemNode.source,
          stemNodes,
          stemBus,
          eqHigh: null,
          eqMid: null,
          eqLow: null,
          volume,
          gain
        })
        continue
      }

      const audioBuffer = entry.audioRef?.audioBuffer
      if (!audioBuffer) continue
      const source =
        useRealtimeKeyLock && entry.masterTempo
          ? createTransportKeyLockSource(offlineCtx as TransportPlayableAudioContext, audioBuffer)
          : createTransportBufferSource(offlineCtx as TransportPlayableAudioContext, audioBuffer)
      source.playbackRate.value = entry.soundTouchRendered ? 1 : entry.tempoRatio

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
      const initialTimelineSec = timelineOriginSec
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
      source.start(
        Math.max(0, entry.startSec - timelineOriginSec),
        entry.soundTouchRendered
          ? Math.max(0, Number(entry.baseLocalStartSec) || 0)
          : Math.max(0, Number(entry.sourceOffsetSec) || 0)
      )
      source.stop(
        Math.max(0, entry.startSec - timelineOriginSec) +
          Math.max(0.02, Number(entry.duration) || 0) +
          0.02
      )

      nodes.push({
        trackId: entry.trackId,
        entry,
        source,
        stemNodes: [],
        stemBus: null,
        eqHigh,
        eqMid,
        eqLow,
        volume,
        gain
      })
    }
    return nodes
  }

  const preprocessEntriesWithSoundTouch = async (
    offlineCtx: OfflineAudioContext,
    entries: RenderTransportEntry[]
  ) => {
    const processedFileKeys = new Set<string>()
    for (const entry of entries) {
      if (!entry.masterTempo || Math.abs(Number(entry.tempoRatio) - 1) <= 0.0001) {
        entry.soundTouchRendered = false
        continue
      }
      try {
        if (isStemMixMode()) {
          for (const stemId of resolveStemIds()) {
            const stemAudio = entry.stemAudioById?.[stemId]
            if (!stemAudio?.audioBuffer) continue
            const processKey = `${stemId}:${stemAudio.filePath}`
            if (processedFileKeys.has(processKey)) continue
            stemAudio.audioBuffer = await processMixtapeAudioBufferWithSoundTouch(
              stemAudio.filePath,
              stemAudio.audioBuffer,
              entry.tempoRatio,
              (channels, frameCount, sampleRate) =>
                offlineCtx.createBuffer(channels, frameCount, sampleRate)
            )
            processedFileKeys.add(processKey)
          }
        } else if (entry.audioRef?.audioBuffer) {
          const processKey = `mix:${entry.audioRef.filePath}`
          if (processedFileKeys.has(processKey)) {
            entry.soundTouchRendered = true
            continue
          }
          entry.audioRef.audioBuffer = await processMixtapeAudioBufferWithSoundTouch(
            entry.audioRef.filePath,
            entry.audioRef.audioBuffer,
            entry.tempoRatio,
            (channels, frameCount, sampleRate) =>
              offlineCtx.createBuffer(channels, frameCount, sampleRate)
          )
          processedFileKeys.add(processKey)
        }
        entry.soundTouchRendered = true
      } catch (error) {
        entry.soundTouchRendered = false
        console.error('[mixtape-output] SoundTouch preprocess failed, fallback to worklet', {
          filePath: entry.filePath,
          tempoRatio: entry.tempoRatio,
          error
        })
      }
    }
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
    const entries = plan.entries as RenderTransportEntry[]
    if (!entries.length) {
      throw new Error(t('mixtape.outputNoTracks'))
    }
    if (plan.missingDurationCount > 0) {
      throw new Error(t('mixtape.transportMissingDuration', { count: plan.missingDurationCount }))
    }
    if (isStemMixMode() && plan.stemNotReadyCount > 0) {
      throw new Error(t('mixtape.stemNotReadyForExport', { count: plan.stemNotReadyCount }))
    }
    if (isStemMixMode() && plan.missingStemAssetCount > 0) {
      throw new Error(t('mixtape.stemNotReadyForExport', { count: plan.missingStemAssetCount }))
    }

    const decodeQueue: TransportEntry[] = []
    const requiredStemIds = resolveStemIds()
    if (isStemMixMode()) {
      for (const entry of entries) {
        let needsDecode = false
        for (const stemId of requiredStemIds) {
          const stemAudio = entry.stemAudioById?.[stemId]
          if (!stemAudio) continue
          const cached = readTransportBufferCache(stemAudio.filePath)
          if (cached) {
            stemAudio.audioBuffer = cached
            continue
          }
          needsDecode = true
        }
        if (needsDecode) {
          decodeQueue.push(entry)
        }
      }
    } else {
      for (const entry of entries) {
        const audioRef = entry.audioRef
        if (!audioRef) continue
        const cached = readTransportBufferCache(audioRef.filePath)
        if (cached) {
          audioRef.audioBuffer = cached
          continue
        }
        decodeQueue.push(entry)
      }
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
            await ensureDecodedTransportEntry(entry)
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

    if (isStemMixMode()) {
      for (const entry of entries) {
        const allDecoded = requiredStemIds.every(
          (stemId) => !!entry.stemAudioById?.[stemId]?.audioBuffer
        )
        if (!allDecoded) {
          throw new Error(t('mixtape.transportDecodeFailed', { count: 1 }))
        }
      }
    } else {
      for (const entry of entries) {
        if (!entry.audioRef?.audioBuffer) {
          throw new Error(t('mixtape.transportDecodeFailed', { count: 1 }))
        }
      }
    }

    const playableEntries = entries.filter((entry) =>
      isStemMixMode()
        ? requiredStemIds.every((stemId) => !!entry.stemAudioById?.[stemId]?.audioBuffer)
        : Boolean(entry.audioRef?.audioBuffer)
    )
    const timelineOriginSec = playableEntries.reduce(
      (min, entry) => Math.min(min, Number(entry.startSec) || 0),
      0
    )
    const durationSec = playableEntries.reduce(
      (max, entry) => Math.max(max, entry.startSec + entry.duration - timelineOriginSec),
      0
    )
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(t('mixtape.transportNoPlayableTracks'))
    }

    const sampleRate = resolveOutputSampleRate(playableEntries)
    const outputChannels = resolveOutputChannels(playableEntries)
    const frameCount = Math.max(1, Math.ceil(durationSec * sampleRate))
    const offlineCtx = new OfflineAudioContext(outputChannels, frameCount, sampleRate)
    await preprocessEntriesWithSoundTouch(offlineCtx, playableEntries)
    let offlineKeyLockWorkletReady = false
    if (playableEntries.some((entry) => entry.masterTempo && !entry.soundTouchRendered)) {
      try {
        await ensureTransportKeyLockWorkletModule(offlineCtx as TransportPlayableAudioContext)
        offlineKeyLockWorkletReady = true
      } catch (error) {
        console.error('[mixtape-output] key lock worklet unavailable, export aborted', error)
        throw new Error(t('mixtape.outputKeyLockUnavailable'))
      }
    }
    const nodes = buildOutputTrackNodes(
      offlineCtx,
      playableEntries,
      timelineOriginSec,
      offlineKeyLockWorkletReady
    )

    emitProgress({
      stageKey: 'mixtape.outputProgressScheduling',
      done: 0,
      total: 100,
      percent: 42
    })
    await scheduleOfflineAutomation({
      nodes,
      durationSec,
      timelineOriginSec,
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
      trackCount: new Set(playableEntries.map((entry) => entry.trackId)).size
    }
  }

  return {
    renderMixtapeOutputWav
  }
}
