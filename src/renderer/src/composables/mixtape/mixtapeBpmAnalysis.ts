import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import { normalizeMixtapeFilePath } from '@renderer/composables/mixtape/mixtapeTrackSnapshot'

type BpmAnalysisEntry = {
  bpm: number
  firstBeatMs: number
  barBeatOffset?: number
}

const resolveBpmAnalysisMap = (results: unknown[]) => {
  const analysisMap = new Map<string, BpmAnalysisEntry>()
  for (const item of results) {
    const payload =
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as {
            filePath?: unknown
            bpm?: unknown
            firstBeatMs?: unknown
            barBeatOffset?: unknown
          })
        : null
    const filePath = normalizeMixtapeFilePath(payload?.filePath)
    const bpmValue = payload?.bpm
    if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue) || bpmValue <= 0) {
      continue
    }
    const rawFirstBeatMs = Number(payload?.firstBeatMs)
    const firstBeatMs = Number.isFinite(rawFirstBeatMs) && rawFirstBeatMs >= 0 ? rawFirstBeatMs : 0
    const rawBarBeatOffset = Number(payload?.barBeatOffset)
    const barBeatOffset = Number.isFinite(rawBarBeatOffset)
      ? ((Math.round(rawBarBeatOffset) % 32) + 32) % 32
      : undefined
    analysisMap.set(filePath, {
      bpm: bpmValue,
      firstBeatMs,
      barBeatOffset
    })
  }
  return analysisMap
}

export const buildMixtapeBpmTargets = (tracks: MixtapeTrack[]) => {
  const unique = new Set<string>()
  const targets: string[] = []
  for (const track of tracks) {
    const filePath = normalizeMixtapeFilePath(track.filePath)
    if (!filePath || unique.has(filePath)) continue
    const bpmValue = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
    const firstBeatMsValue = Number(track.firstBeatMs)
    const barBeatOffsetValue = Number(track.barBeatOffset)
    const hasValidBpm = Number.isFinite(bpmValue) && bpmValue > 0
    const hasValidFirstBeatMs = Number.isFinite(firstBeatMsValue) && firstBeatMsValue >= 0
    const hasValidBarBeatOffset = Number.isFinite(barBeatOffsetValue)
    if (hasValidBpm && hasValidFirstBeatMs && hasValidBarBeatOffset) continue
    unique.add(filePath)
    targets.push(filePath)
  }
  return targets
}

export const buildMixtapeBpmTargetKey = (filePaths: string[]) => [...filePaths].sort().join('|')

export const resolveMissingBpmTrackCount = (tracks: MixtapeTrack[], bpmTargets: Set<string>) => {
  if (!bpmTargets.size) return 0
  return tracks.filter((track) => {
    const trackPath = normalizeMixtapeFilePath(track.filePath)
    if (!trackPath || !bpmTargets.has(trackPath)) return false
    const bpmValue = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
    const firstBeatMsValue = Number(track.firstBeatMs)
    const barBeatOffsetValue = Number(track.barBeatOffset)
    const missingBpm = !Number.isFinite(bpmValue) || bpmValue <= 0
    const missingFirstBeat = !Number.isFinite(firstBeatMsValue) || firstBeatMsValue < 0
    const missingBarBeatOffset = !Number.isFinite(barBeatOffsetValue)
    return missingBpm || missingFirstBeat || missingBarBeatOffset
  }).length
}

export const applyBpmResultsToTracks = (tracks: MixtapeTrack[], results: unknown[]) => {
  const analysisMap = resolveBpmAnalysisMap(results)
  if (analysisMap.size === 0) {
    return {
      nextTracks: tracks,
      resolvedCount: 0,
      changedCount: 0
    }
  }

  let changedCount = 0
  const nextTracks = tracks.map((track) => {
    const trackPath = normalizeMixtapeFilePath(track.filePath)
    const trackAnalysis = trackPath ? analysisMap.get(trackPath) : undefined
    if (!trackAnalysis) return track
    const currentBpm = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
    const hasCurrentFirstBeatMs =
      typeof track.firstBeatMs === 'number' &&
      Number.isFinite(track.firstBeatMs) &&
      track.firstBeatMs >= 0
    const hasCurrentBarBeatOffset =
      typeof track.barBeatOffset === 'number' && Number.isFinite(track.barBeatOffset)
    const currentFirstBeatMs = hasCurrentFirstBeatMs ? Number(track.firstBeatMs) : 0
    const currentBarBeatOffset = hasCurrentBarBeatOffset ? Number(track.barBeatOffset) : 0
    const bpmChanged =
      !Number.isFinite(currentBpm) || Math.abs(trackAnalysis.bpm - currentBpm) > 0.0001
    const firstBeatChanged =
      !hasCurrentFirstBeatMs || Math.abs(trackAnalysis.firstBeatMs - currentFirstBeatMs) > 0.001
    const barBeatOffsetChanged =
      trackAnalysis.barBeatOffset !== undefined &&
      (!hasCurrentBarBeatOffset || trackAnalysis.barBeatOffset !== currentBarBeatOffset)
    if (!bpmChanged && !firstBeatChanged && !barBeatOffsetChanged) return track
    changedCount += 1
    return {
      ...track,
      // BPM 分析结果代表音频本身的真实原始速度，必须覆盖旧的脏 originalBpm。
      gridBaseBpm: trackAnalysis.bpm,
      originalBpm: trackAnalysis.bpm,
      bpm: trackAnalysis.bpm,
      masterTempo: track.masterTempo !== false,
      firstBeatMs: trackAnalysis.firstBeatMs,
      barBeatOffset: trackAnalysis.barBeatOffset ?? track.barBeatOffset
    }
  })

  return {
    nextTracks,
    resolvedCount: analysisMap.size,
    changedCount
  }
}
