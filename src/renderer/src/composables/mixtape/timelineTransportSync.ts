import {
  clampNumber,
  resolveSyncPlaybackRateWithDiagnostics
} from '@renderer/composables/mixtape/mixxxSyncModel'

export type TransportSyncEntry = {
  trackId: string
  startSec: number
  sourceDuration?: number
  duration: number
  bpm: number
  beatSec: number
  masterTempo: boolean
  syncAnchorSec: number
  tempoRatio: number
}

export type TransportSyncNode = {
  trackId: string
  entry: TransportSyncEntry
  source: AudioBufferSourceNode
  runtimeSyncAnchorSec?: number
  phaseAnchorLocked?: boolean
  phaseAnchorMasterTrackId?: string
  estimatedSourceSec?: number
  lastTimelineSec?: number
}

type ApplyTransportSyncParams = {
  nodes: TransportSyncNode[]
  timelineSec: number
  masterTrackId: string
  audioCtx: BaseAudioContext | null
  collectDiagnostics?: boolean
}

export type TransportSyncDiagnostic = {
  trackId: string
  master: boolean
  bpm: number
  beatSec: number
  syncAnchorSec: number
  originSyncAnchorSec: number
  phaseAnchorCorrectionSec: number
  baseRate: number
  currentRate: number
  tempoScale: number
  tempoSyncedRate: number
  rawPhaseErrorSec: number
  postPhaseErrorSec: number
  phaseErrorSec: number
  phasePull: number
  appliedRate: number
  transientLagMs: number | null
  transientCorr: number | null
  transientWindowMs: number | null
}

export type ApplyTransportSyncResult = {
  masterTrackId: string
  activeTrackCount: number
  diagnostics: TransportSyncDiagnostic[]
}

type TransientLagDiagnostics = {
  lagMs: number
  correlation: number
  windowMs: number
}

const TRANSIENT_PROBE_WINDOW_SAMPLES = 2048
const TRANSIENT_PROBE_MAX_LAG_SAMPLES = 192
const TRANSIENT_MIN_CORRELATION = 0.08

const resolveNodeSourceDurationSec = (node: TransportSyncNode) => {
  const bufferDuration = Number(node.source.buffer?.duration)
  if (Number.isFinite(bufferDuration) && bufferDuration > 0) return bufferDuration
  const sourceDuration = Number(node.entry.sourceDuration)
  if (Number.isFinite(sourceDuration) && sourceDuration > 0) return sourceDuration
  return 0
}

const resolveInitialEstimatedSourceSec = (
  node: TransportSyncNode,
  timelineSec: number,
  playbackRate: number
) => {
  const durationSec = resolveNodeSourceDurationSec(node)
  if (!durationSec) return null
  const startSec = Number(node.entry.startSec) || 0
  const elapsedTimelineSec = Math.max(0, timelineSec - startSec)
  const estimated = elapsedTimelineSec * clampNumber(playbackRate, 0.25, 4)
  return clampNumber(estimated, 0, Math.max(0, durationSec - 0.001))
}

const updateEstimatedSourceSec = (
  node: TransportSyncNode,
  timelineSec: number,
  playbackRate: number
) => {
  const durationSec = resolveNodeSourceDurationSec(node)
  if (!durationSec) return null
  const safeRate = clampNumber(playbackRate, 0.25, 4)
  const lastTimelineSec = Number(node.lastTimelineSec)
  const currentEstimated = Number(node.estimatedSourceSec)
  const canIntegrate =
    Number.isFinite(lastTimelineSec) &&
    Number.isFinite(currentEstimated) &&
    timelineSec >= lastTimelineSec &&
    timelineSec - lastTimelineSec <= 2
  const estimated = canIntegrate
    ? currentEstimated + (timelineSec - lastTimelineSec) * safeRate
    : resolveInitialEstimatedSourceSec(node, timelineSec, safeRate)
  if (!Number.isFinite(Number(estimated))) return null
  const nextEstimated = clampNumber(Number(estimated), 0, Math.max(0, durationSec - 0.001))
  node.estimatedSourceSec = nextEstimated
  node.lastTimelineSec = timelineSec
  return nextEstimated
}

const resolveChannelData = (buffer: AudioBuffer | null) => {
  if (!buffer || buffer.numberOfChannels <= 0) return null
  try {
    return buffer.getChannelData(0)
  } catch {
    return null
  }
}

const resolveTransientLagDiagnostics = (params: {
  masterNode: TransportSyncNode
  targetNode: TransportSyncNode
  masterSourceSec: number
  targetSourceSec: number
}): TransientLagDiagnostics | null => {
  const masterBuffer = params.masterNode.source.buffer || null
  const targetBuffer = params.targetNode.source.buffer || null
  if (!masterBuffer || !targetBuffer) return null
  const masterRate = Number(masterBuffer.sampleRate)
  const targetRate = Number(targetBuffer.sampleRate)
  if (
    !Number.isFinite(masterRate) ||
    !Number.isFinite(targetRate) ||
    masterRate <= 0 ||
    targetRate <= 0
  ) {
    return null
  }
  if (Math.abs(masterRate - targetRate) > 1) return null
  const masterData = resolveChannelData(masterBuffer)
  const targetData = resolveChannelData(targetBuffer)
  if (!masterData || !targetData) return null

  const windowSamples = TRANSIENT_PROBE_WINDOW_SAMPLES
  const halfWindow = Math.floor(windowSamples / 2)
  const maxLag = TRANSIENT_PROBE_MAX_LAG_SAMPLES
  const masterCenter = Math.round(params.masterSourceSec * masterRate)
  const targetCenter = Math.round(params.targetSourceSec * targetRate)
  const masterStart = masterCenter - halfWindow
  const targetStart = targetCenter - halfWindow
  const masterEnd = masterStart + windowSamples
  const targetEnd = targetStart + windowSamples
  if (masterStart < 0 || targetStart < 0) return null
  if (masterEnd > masterData.length || targetEnd > targetData.length) return null

  const masterWindow = masterData.subarray(masterStart, masterEnd)
  const targetWindow = targetData.subarray(targetStart, targetEnd)
  let bestLag = 0
  let bestScore = -1
  let bestCorrelation = 0

  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const srcStart = lag < 0 ? -lag : 0
    const dstStart = lag > 0 ? lag : 0
    const overlap = windowSamples - Math.abs(lag)
    if (overlap <= 32) continue

    let sum = 0
    let sumMaster = 0
    let sumTarget = 0
    for (let index = 0; index < overlap; index += 1) {
      const masterValue = masterWindow[srcStart + index] || 0
      const targetValue = targetWindow[dstStart + index] || 0
      sum += masterValue * targetValue
      sumMaster += masterValue * masterValue
      sumTarget += targetValue * targetValue
    }
    if (sumMaster <= 1e-9 || sumTarget <= 1e-9) continue
    const correlation = sum / Math.sqrt(sumMaster * sumTarget)
    const score = Math.abs(correlation)
    if (score <= bestScore) continue
    bestScore = score
    bestLag = lag
    bestCorrelation = correlation
  }

  if (bestScore < TRANSIENT_MIN_CORRELATION) return null
  return {
    lagMs: (bestLag / masterRate) * 1000,
    correlation: bestCorrelation,
    windowMs: (windowSamples / masterRate) * 1000
  }
}

export const applyMixxxTransportSync = (
  params: ApplyTransportSyncParams
): ApplyTransportSyncResult => {
  const { nodes, timelineSec, audioCtx } = params
  const collectDiagnostics = Boolean(params.collectDiagnostics)
  if (!audioCtx || audioCtx.state === 'closed') {
    return {
      masterTrackId: params.masterTrackId,
      activeTrackCount: 0,
      diagnostics: []
    }
  }

  const activeNodes = nodes.filter((node) => {
    const entry = node.entry
    if (!entry.masterTempo || !Number.isFinite(entry.beatSec) || entry.beatSec <= 0) return false
    const start = Number(entry.startSec) || 0
    const end = start + (Number(entry.duration) || 0)
    return timelineSec >= start && timelineSec <= end
  })
  if (!activeNodes.length) {
    return {
      masterTrackId: '',
      activeTrackCount: 0,
      diagnostics: []
    }
  }

  let nextMasterId = params.masterTrackId
  const existingMaster = activeNodes.find((node) => node.trackId === nextMasterId) || null
  const masterNode =
    existingMaster || [...activeNodes].sort((a, b) => a.entry.startSec - b.entry.startSec)[0]
  if (!masterNode) {
    return {
      masterTrackId: '',
      activeTrackCount: 0,
      diagnostics: []
    }
  }
  nextMasterId = masterNode.trackId

  const masterEntry = masterNode.entry
  const masterBpm = Number(masterEntry.bpm)
  const masterAnchorSec = Number(masterEntry.syncAnchorSec)
  const diagnostics: TransportSyncDiagnostic[] = []
  const orderedActiveNodes = [
    masterNode,
    ...activeNodes.filter((node) => node.trackId !== masterNode.trackId)
  ]
  let masterEstimatedSourceSec: number | null = null
  for (const node of orderedActiveNodes) {
    const entry = node.entry
    const isMasterNode = node.trackId === masterNode.trackId
    const originSyncAnchorSec = Number(entry.syncAnchorSec)
    const safeOriginSyncAnchorSec = Number.isFinite(originSyncAnchorSec) ? originSyncAnchorSec : 0
    const baseRate = clampNumber(entry.tempoRatio, 0.25, 4)
    const currentRate = clampNumber(Number(node.source.playbackRate.value) || 1, 0.25, 4)
    let runtimeSyncAnchorSec = Number.isFinite(Number(node.runtimeSyncAnchorSec))
      ? Number(node.runtimeSyncAnchorSec)
      : safeOriginSyncAnchorSec
    if (isMasterNode) {
      runtimeSyncAnchorSec = safeOriginSyncAnchorSec
      node.phaseAnchorLocked = true
      node.phaseAnchorMasterTrackId = masterNode.trackId
    } else if (node.phaseAnchorMasterTrackId !== masterNode.trackId) {
      node.phaseAnchorLocked = false
      node.phaseAnchorMasterTrackId = masterNode.trackId
    }
    node.runtimeSyncAnchorSec = runtimeSyncAnchorSec
    let tempoScale = 1
    let tempoSyncedRate = baseRate
    let rawPhaseErrorSec = 0
    let postPhaseErrorSec = 0
    let phaseErrorSec = 0
    let phasePull = 0
    let nextRate = baseRate
    if (!isMasterNode) {
      const rawSyncDiagnostics = resolveSyncPlaybackRateWithDiagnostics({
        basePlaybackRate: baseRate,
        targetBpm: Number(entry.bpm),
        masterBpm,
        targetAnchorSec: runtimeSyncAnchorSec,
        masterAnchorSec,
        timelineSec,
        phaseLockStrength: 0.16,
        maxPhasePull: 0.05
      })
      rawPhaseErrorSec = rawSyncDiagnostics.phaseErrorSec
      let postSyncDiagnostics = rawSyncDiagnostics
      if (!node.phaseAnchorLocked) {
        runtimeSyncAnchorSec -= rawSyncDiagnostics.phaseErrorSec
        node.runtimeSyncAnchorSec = runtimeSyncAnchorSec
        node.phaseAnchorLocked = true
        postSyncDiagnostics = resolveSyncPlaybackRateWithDiagnostics({
          basePlaybackRate: baseRate,
          targetBpm: Number(entry.bpm),
          masterBpm,
          targetAnchorSec: runtimeSyncAnchorSec,
          masterAnchorSec,
          timelineSec,
          phaseLockStrength: 0.16,
          maxPhasePull: 0.05
        })
      }
      postPhaseErrorSec = postSyncDiagnostics.phaseErrorSec
      nextRate = postSyncDiagnostics.rate
      tempoScale = postSyncDiagnostics.tempoScale
      tempoSyncedRate = postSyncDiagnostics.tempoSyncedRate
      phaseErrorSec = postSyncDiagnostics.phaseErrorSec
      phasePull = postSyncDiagnostics.phasePull
    }
    try {
      node.source.playbackRate.setTargetAtTime(nextRate, audioCtx.currentTime, 0.04)
    } catch {}
    const estimatedSourceSec = updateEstimatedSourceSec(node, timelineSec, nextRate)
    if (isMasterNode) {
      masterEstimatedSourceSec = estimatedSourceSec
    }
    let transientLagMs: number | null = null
    let transientCorr: number | null = null
    let transientWindowMs: number | null = null
    if (
      !isMasterNode &&
      collectDiagnostics &&
      masterEstimatedSourceSec !== null &&
      estimatedSourceSec !== null
    ) {
      const transientDiagnostics = resolveTransientLagDiagnostics({
        masterNode,
        targetNode: node,
        masterSourceSec: masterEstimatedSourceSec,
        targetSourceSec: estimatedSourceSec
      })
      if (transientDiagnostics) {
        transientLagMs = transientDiagnostics.lagMs
        transientCorr = transientDiagnostics.correlation
        transientWindowMs = transientDiagnostics.windowMs
      }
    }
    if (!collectDiagnostics) continue
    diagnostics.push({
      trackId: node.trackId,
      master: isMasterNode,
      bpm: Number(entry.bpm),
      beatSec: Number(entry.beatSec),
      syncAnchorSec: runtimeSyncAnchorSec,
      originSyncAnchorSec: safeOriginSyncAnchorSec,
      phaseAnchorCorrectionSec: runtimeSyncAnchorSec - safeOriginSyncAnchorSec,
      baseRate,
      currentRate,
      tempoScale,
      tempoSyncedRate,
      rawPhaseErrorSec,
      postPhaseErrorSec,
      phaseErrorSec,
      phasePull,
      appliedRate: nextRate,
      transientLagMs,
      transientCorr,
      transientWindowMs
    })
  }
  return {
    masterTrackId: nextMasterId,
    activeTrackCount: activeNodes.length,
    diagnostics
  }
}
