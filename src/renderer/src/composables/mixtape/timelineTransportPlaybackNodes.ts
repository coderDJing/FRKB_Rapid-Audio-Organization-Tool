import {
  createTransportBufferSource,
  createTransportKeyLockSource,
  createTransportSoundTouchPreviewSource,
  type TransportPlayableSource
} from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import type {
  TransportEntry,
  TransportStemAudioRef,
  TransportStemId
} from '@renderer/composables/mixtape/timelineTransportAudioData'

export type TrackStemGraphNode = {
  stemId: TransportStemId
  source: TransportPlayableSource
  stemGain: GainNode
}

export type TrackGraphNode = {
  trackId: string
  entry: TransportEntry
  source: TransportPlayableSource
  stemNodes: TrackStemGraphNode[]
  stemBus: GainNode | null
  eqHigh: BiquadFilterNode | null
  eqMid: BiquadFilterNode | null
  eqLow: BiquadFilterNode | null
  volume: GainNode
  gain: GainNode
}

type StartTransportTrackGraphNodeParams = {
  entry: TransportEntry
  offsetTimelineSec: number
  offsetSourceSec: number
  whenSec: number
  transportGraphNodes: TrackGraphNode[]
  isStemMixMode: () => boolean
  resolveStemIdsForMode: () => TransportStemId[]
  ensureTransportAudioContext: (sampleRate?: number) => AudioContext
  resolveTransportOutputNode: (ctx: AudioContext) => AudioNode
  shouldUseRealtimeKeyLock: (entry: TransportEntry) => boolean
  resolveEntryEnvelopeValue: (
    entry: TransportEntry,
    param: 'volume' | 'gain' | TransportStemId,
    timelineOffsetSec: number
  ) => number
  resolveEntryEqDbValue: (
    entry: TransportEntry,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => number
}

export const startTransportTrackGraphNode = (params: StartTransportTrackGraphNodeParams) => {
  const {
    entry,
    offsetTimelineSec,
    offsetSourceSec,
    whenSec,
    transportGraphNodes,
    isStemMixMode,
    resolveStemIdsForMode,
    ensureTransportAudioContext,
    resolveTransportOutputNode,
    shouldUseRealtimeKeyLock,
    resolveEntryEnvelopeValue,
    resolveEntryEqDbValue
  } = params

  if (isStemMixMode()) {
    const stemIds = resolveStemIdsForMode()
    const stemAudios = stemIds
      .map((stemId) => entry.stemAudioById?.[stemId])
      .filter((item): item is TransportStemAudioRef => !!item && !!item.audioBuffer)
    if (!stemAudios.length) return
    try {
      const sampleRate = Number(stemAudios[0]?.audioBuffer?.sampleRate || 0) || undefined
      const ctx = ensureTransportAudioContext(sampleRate)
      if (ctx.state === 'suspended') {
        void ctx.resume()
      }

      const stemBus = ctx.createGain()
      const volume = ctx.createGain()
      const gain = ctx.createGain()
      const outputNode = resolveTransportOutputNode(ctx)
      volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
      gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)
      stemBus.gain.value = 1
      stemBus.connect(volume)
      volume.connect(gain)
      gain.connect(outputNode)

      const stemNodes: TrackStemGraphNode[] = []
      for (const stemAudio of stemAudios) {
        const source = shouldUseRealtimeKeyLock(entry)
          ? createTransportSoundTouchPreviewSource(ctx, stemAudio.audioBuffer as AudioBuffer)
          : createTransportBufferSource(ctx, stemAudio.audioBuffer as AudioBuffer)
        source.playbackRate.value = entry.tempoRatio
        const stemGain = ctx.createGain()
        stemGain.gain.value = resolveEntryEnvelopeValue(entry, stemAudio.stemId, offsetTimelineSec)
        source.connect(stemGain)
        stemGain.connect(stemBus)
        stemNodes.push({
          stemId: stemAudio.stemId,
          source,
          stemGain
        })
      }
      const primaryStemNode = stemNodes[0]
      if (!primaryStemNode) {
        try {
          stemBus.disconnect()
        } catch {}
        try {
          volume.disconnect()
        } catch {}
        try {
          gain.disconnect()
        } catch {}
        return
      }

      const safeWhen = Number.isFinite(whenSec)
        ? Math.max(ctx.currentTime, whenSec)
        : ctx.currentTime
      const remainingTimelineSec = Math.max(0.02, Number(entry.duration) - offsetTimelineSec)
      for (const stemNode of stemNodes) {
        const stemDuration = Number(stemNode.source.buffer?.duration || 0)
        const safeOffset = Math.max(0, Math.min(offsetSourceSec, Math.max(0, stemDuration - 0.02)))
        stemNode.source.start(safeWhen, safeOffset)
        stemNode.source.stop(safeWhen + remainingTimelineSec + 0.02)
      }

      const graphNode: TrackGraphNode = {
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
      }
      transportGraphNodes.push(graphNode)

      let cleaned = false
      const cleanupNode = () => {
        if (cleaned) return
        cleaned = true
        const idx = transportGraphNodes.indexOf(graphNode)
        if (idx >= 0) transportGraphNodes.splice(idx, 1)
        for (const stemNode of stemNodes) {
          try {
            stemNode.source.disconnect()
          } catch {}
          try {
            stemNode.stemGain.disconnect()
          } catch {}
        }
        try {
          stemBus.disconnect()
        } catch {}
        try {
          volume.disconnect()
        } catch {}
        try {
          gain.disconnect()
        } catch {}
      }
      primaryStemNode.source.onended = cleanupNode
    } catch (error) {
      console.error('[mixtape-transport] 播放启动失败:', entry.filePath, error)
    }
    return
  }

  const audioBuffer = entry.audioRef?.audioBuffer
  if (!audioBuffer) return
  try {
    const ctx = ensureTransportAudioContext(audioBuffer.sampleRate)
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    const source = shouldUseRealtimeKeyLock(entry)
      ? createTransportSoundTouchPreviewSource(ctx, audioBuffer)
      : createTransportBufferSource(ctx, audioBuffer)
    source.playbackRate.value = entry.tempoRatio

    const eqLow = ctx.createBiquadFilter()
    eqLow.type = 'lowshelf'
    eqLow.frequency.value = 220

    const eqMid = ctx.createBiquadFilter()
    eqMid.type = 'peaking'
    eqMid.frequency.value = 1000
    eqMid.Q.value = 0.9

    const eqHigh = ctx.createBiquadFilter()
    eqHigh.type = 'highshelf'
    eqHigh.frequency.value = 3200

    const volume = ctx.createGain()
    const gain = ctx.createGain()
    const outputNode = resolveTransportOutputNode(ctx)
    eqHigh.gain.value = resolveEntryEqDbValue(entry, 'high', offsetTimelineSec)
    eqMid.gain.value = resolveEntryEqDbValue(entry, 'mid', offsetTimelineSec)
    eqLow.gain.value = resolveEntryEqDbValue(entry, 'low', offsetTimelineSec)
    volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
    gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)

    source.connect(eqLow)
    eqLow.connect(eqMid)
    eqMid.connect(eqHigh)
    eqHigh.connect(volume)
    volume.connect(gain)
    gain.connect(outputNode)

    const safeWhen = Number.isFinite(whenSec) ? Math.max(ctx.currentTime, whenSec) : ctx.currentTime
    const safeOffset = Math.max(
      0,
      Math.min(offsetSourceSec, Math.max(0, audioBuffer.duration - 0.02))
    )
    source.start(safeWhen, safeOffset)
    source.stop(safeWhen + Math.max(0.02, Number(entry.duration) - offsetTimelineSec) + 0.02)

    const graphNode: TrackGraphNode = {
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
    }
    transportGraphNodes.push(graphNode)

    let cleaned = false
    const cleanupNode = () => {
      if (cleaned) return
      cleaned = true
      const idx = transportGraphNodes.indexOf(graphNode)
      if (idx >= 0) transportGraphNodes.splice(idx, 1)
      try {
        source.disconnect()
      } catch {}
      try {
        eqLow.disconnect()
      } catch {}
      try {
        eqMid.disconnect()
      } catch {}
      try {
        eqHigh.disconnect()
      } catch {}
      try {
        volume.disconnect()
      } catch {}
      try {
        gain.disconnect()
      } catch {}
    }
    source.onended = cleanupNode
  } catch (error) {
    console.error('[mixtape-transport] 播放启动失败:', entry.filePath, error)
  }
}
