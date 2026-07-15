type GridAnchorParams = {
  startSec: number
  firstBeatSec: number
  beatSec: number
  downbeatBeatOffset: number
}

type SyncPlaybackRateParams = {
  basePlaybackRate: number
  targetBpm: number
  masterBpm: number
  targetAnchorSec: number
  masterAnchorSec: number
  timelineSec: number
  mapMasterSecToBeats?: (sec: number) => number
  phaseLockStrength?: number
  maxPhasePull?: number
}

type SyncPlaybackRateDiagnostics = {
  rate: number
  baseRate: number
  tempoScale: number
  tempoSyncedRate: number
  masterBeatSec: number
  phaseErrorSec: number
  phasePull: number
}

const BEAT_SYNC_MIN_RATE = 0.25
const BEAT_SYNC_MAX_RATE = 4

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const normalizeBeatOffset = (value: unknown, interval: number = 32) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

export const resolveBeatSecByBpm = (bpm: number) => {
  const numeric = Number(bpm)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return 60 / numeric
}

export const resolveTempoRatioByBpm = (targetBpm: number, originalBpm: number) => {
  const target = Number(targetBpm)
  const original = Number(originalBpm)
  if (!Number.isFinite(target) || !Number.isFinite(original) || target <= 0 || original <= 0) {
    return 1
  }
  return clampNumber(target / original, BEAT_SYNC_MIN_RATE, BEAT_SYNC_MAX_RATE)
}

export const resolveFirstBeatTimelineSec = (firstBeatMs: unknown, tempoRatio: number) => {
  const firstBeatSec = Number(firstBeatMs) / 1000
  if (!Number.isFinite(firstBeatSec) || firstBeatSec <= 0) return 0
  const ratio = Number(tempoRatio)
  if (!Number.isFinite(ratio) || ratio <= 0) return firstBeatSec
  return firstBeatSec / ratio
}

export const resolveGridAnchorSec = (params: GridAnchorParams) => {
  const beatSec = Number(params.beatSec)
  if (!Number.isFinite(beatSec) || beatSec <= 0) {
    return Number(params.startSec) + Number(params.firstBeatSec || 0)
  }
  const downbeatOffset = normalizeBeatOffset(params.downbeatBeatOffset, 4)
  return Number(params.startSec) + Number(params.firstBeatSec || 0) + downbeatOffset * beatSec
}

const wrapPhaseDiffSec = (diffSec: number, beatSec: number) => {
  const period = Number(beatSec)
  if (!Number.isFinite(period) || period <= 0) return 0
  let wrapped = diffSec % period
  if (wrapped > period / 2) wrapped -= period
  if (wrapped < -period / 2) wrapped += period
  return wrapped
}

const resolvePhaseSecAtTime = (timelineSec: number, anchorSec: number, beatSec: number) => {
  const period = Number(beatSec)
  if (!Number.isFinite(period) || period <= 0) return 0
  const raw = (timelineSec - anchorSec) % period
  return raw >= 0 ? raw : raw + period
}

export const resolveSyncPlaybackRateWithDiagnostics = (
  params: SyncPlaybackRateParams
): SyncPlaybackRateDiagnostics => {
  const baseRate = clampNumber(
    Number(params.basePlaybackRate) || 1,
    BEAT_SYNC_MIN_RATE,
    BEAT_SYNC_MAX_RATE
  )
  const targetBpm = Number(params.targetBpm)
  const masterBpm = Number(params.masterBpm)
  if (
    !Number.isFinite(targetBpm) ||
    targetBpm <= 0 ||
    !Number.isFinite(masterBpm) ||
    masterBpm <= 0
  ) {
    return {
      rate: baseRate,
      baseRate,
      tempoScale: 1,
      tempoSyncedRate: baseRate,
      masterBeatSec: 0,
      phaseErrorSec: 0,
      phasePull: 0
    }
  }

  // 先做 tempo sync，把当前 deck tempo 拉到 master tempo。
  const tempoScale = clampNumber(masterBpm / targetBpm, 0.5, 2)
  const tempoSyncedRate = clampNumber(baseRate * tempoScale, BEAT_SYNC_MIN_RATE, BEAT_SYNC_MAX_RATE)

  const masterBeatSec = resolveBeatSecByBpm(masterBpm)
  if (!masterBeatSec) {
    return {
      rate: tempoSyncedRate,
      baseRate,
      tempoScale,
      tempoSyncedRate,
      masterBeatSec: 0,
      phaseErrorSec: 0,
      phasePull: 0
    }
  }

  // 动态主 BPM 必须基于累计拍数计算相位；用当前拍长做时间取模会在变速时产生假相位误差。
  const mapMasterSecToBeats = params.mapMasterSecToBeats
  const phaseErrorSec =
    typeof mapMasterSecToBeats === 'function'
      ? wrapPhaseDiffSec(
          mapMasterSecToBeats(Number(params.masterAnchorSec)) -
            mapMasterSecToBeats(Number(params.targetAnchorSec)),
          1
        ) * masterBeatSec
      : wrapPhaseDiffSec(
          resolvePhaseSecAtTime(
            Number(params.timelineSec),
            Number(params.masterAnchorSec),
            masterBeatSec
          ) -
            resolvePhaseSecAtTime(
              Number(params.timelineSec),
              Number(params.targetAnchorSec),
              masterBeatSec
            ),
          masterBeatSec
        )
  const phaseLockStrength = clampNumber(Number(params.phaseLockStrength) || 0.12, 0, 0.5)
  const maxPhasePull = clampNumber(Number(params.maxPhasePull) || 0.04, 0, 0.15)
  const phasePull = clampNumber(
    (phaseErrorSec / masterBeatSec) * phaseLockStrength,
    -maxPhasePull,
    maxPhasePull
  )

  return {
    rate: clampNumber(tempoSyncedRate * (1 + phasePull), BEAT_SYNC_MIN_RATE, BEAT_SYNC_MAX_RATE),
    baseRate,
    tempoScale,
    tempoSyncedRate,
    masterBeatSec,
    phaseErrorSec,
    phasePull
  }
}
