import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import {
  normalizeBpm,
  normalizeMixtapeFilePath
} from '@renderer/composables/mixtape/mixtapeTrackSnapshot'

type BpmAnalysisEntry = {
  bpm: number
  firstBeatMs: number
}

const resolveBpmAnalysisMap = (results: unknown[]) => {
  const analysisMap = new Map<string, BpmAnalysisEntry>()
  for (const item of results) {
    const filePath = normalizeMixtapeFilePath((item as any)?.filePath)
    const bpmValue = (item as any)?.bpm
    if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue) || bpmValue <= 0) {
      continue
    }
    const rawFirstBeatMs = Number((item as any)?.firstBeatMs)
    const firstBeatMs = Number.isFinite(rawFirstBeatMs) && rawFirstBeatMs >= 0 ? rawFirstBeatMs : 0
    analysisMap.set(filePath, {
      bpm: bpmValue,
      firstBeatMs
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
    const bpmValue = Number(track.bpm)
    const firstBeatMsValue = Number(track.firstBeatMs)
    const hasValidBpm = Number.isFinite(bpmValue) && bpmValue > 0
    const hasValidFirstBeatMs = Number.isFinite(firstBeatMsValue) && firstBeatMsValue >= 0
    if (hasValidBpm && hasValidFirstBeatMs) continue
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
    const bpmValue = Number(track.bpm)
    const firstBeatMsValue = Number(track.firstBeatMs)
    const missingBpm = !Number.isFinite(bpmValue) || bpmValue <= 0
    const missingFirstBeat = !Number.isFinite(firstBeatMsValue) || firstBeatMsValue < 0
    return missingBpm || missingFirstBeat
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
    const currentBpm = Number(track.bpm)
    const hasCurrentFirstBeatMs =
      typeof track.firstBeatMs === 'number' &&
      Number.isFinite(track.firstBeatMs) &&
      track.firstBeatMs >= 0
    const currentFirstBeatMs = hasCurrentFirstBeatMs ? Number(track.firstBeatMs) : 0
    const bpmChanged =
      !Number.isFinite(currentBpm) || Math.abs(trackAnalysis.bpm - currentBpm) > 0.0001
    const firstBeatChanged =
      !hasCurrentFirstBeatMs || Math.abs(trackAnalysis.firstBeatMs - currentFirstBeatMs) > 0.001
    if (!bpmChanged && !firstBeatChanged) return track
    changedCount += 1
    return {
      ...track,
      bpm: trackAnalysis.bpm,
      gridBaseBpm:
        normalizeBpm(track.gridBaseBpm) ?? normalizeBpm(track.originalBpm) ?? trackAnalysis.bpm,
      originalBpm:
        Number.isFinite(Number(track.originalBpm)) && Number(track.originalBpm) > 0
          ? track.originalBpm
          : trackAnalysis.bpm,
      masterTempo: track.masterTempo !== false,
      firstBeatMs: trackAnalysis.firstBeatMs
    }
  })

  return {
    nextTracks,
    resolvedCount: analysisMap.size,
    changedCount
  }
}
