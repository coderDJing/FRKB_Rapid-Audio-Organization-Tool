import { createTrackTimeMapFromSnapshotPayload } from '@renderer/composables/mixtape/trackTimeMapFactory'
import {
  mapPlaybackSequencePlanToLocalSec,
  mapPlaybackSequenceLocalToPlanSec
} from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'
import type { TransportEntry } from '@renderer/composables/mixtape/timelineTransportAudioData'
import type { TrackGraphNode } from '@renderer/composables/mixtape/timelineTransportPlaybackNodes'

/**
 * Transport 的「源播放位置 ↔ 时间轴秒」坐标换算。
 * 从 timelineTransportAndDrag 抽出：这组函数互为闭合调用图、不依赖 transport 调度状态，
 * 只对传入的 entry / node 做映射运算。
 */

// 运行时源时钟与时间轴允许的最大漂移（秒），超过视为无效采样。
const MAX_SOURCE_CLOCK_DRIFT_SEC = 2

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const resolveEntryPlaybackOffsetSourceSec = (
  entry: TransportEntry,
  sectionTimelineOffsetSec: number
) => {
  const localStartSec = Math.max(0, Number(entry.localStartSec) || 0)
  const sectionOffsetSec = clampNumber(
    Number(sectionTimelineOffsetSec) || 0,
    0,
    Math.max(0, Number(entry.duration) || 0)
  )
  const timeMap = createTrackTimeMapFromSnapshotPayload(entry.tempoSnapshot)
  const sourceOffsetSec = Math.max(0, Number(entry.sourceOffsetSec) || 0)
  const sourceSegmentDuration = Math.max(0, Number(entry.sourceSegmentDuration) || 0)
  const sourceLocalSec = timeMap.mapLocalToSource(localStartSec + sectionOffsetSec)
  return clampNumber(
    Number(sourceLocalSec) || sourceOffsetSec,
    sourceOffsetSec,
    Math.max(sourceOffsetSec, sourceOffsetSec + sourceSegmentDuration)
  )
}

export const resolveEntryPlaybackOffsetPlanSec = (
  entry: TransportEntry,
  sectionTimelineOffsetSec: number
) => {
  if (!entry.playbackSequence?.segments?.length) {
    return resolveEntryPlaybackOffsetSourceSec(entry, sectionTimelineOffsetSec)
  }
  const localStartSec = Math.max(0, Number(entry.localStartSec) || 0)
  const sectionOffsetSec = clampNumber(
    Number(sectionTimelineOffsetSec) || 0,
    0,
    Math.max(0, Number(entry.duration) || 0)
  )
  const baseTimeMap = createTrackTimeMapFromSnapshotPayload({
    ...entry.tempoSnapshot,
    durationSec: entry.tempoSnapshot.baseDurationSec,
    loopSegments: undefined,
    loopSegment: undefined
  })
  return mapPlaybackSequenceLocalToPlanSec({
    localSec: localStartSec + sectionOffsetSec,
    sequence: entry.playbackSequence,
    mapBaseLocalToSource: (localSec: number) => baseTimeMap.mapLocalToSource(localSec)
  })
}

export const resolveSourceLatencySec = (
  source: Pick<TrackGraphNode['source'], 'resolveLatencySec'> | null | undefined
) => {
  if (!source?.resolveLatencySec) return 0
  const latencySec = Number(source.resolveLatencySec())
  if (!Number.isFinite(latencySec) || latencySec <= 0) return 0
  return latencySec
}

export const createEntryBaseTimeMap = (entry: TransportEntry) =>
  createTrackTimeMapFromSnapshotPayload({
    ...entry.tempoSnapshot,
    durationSec: entry.tempoSnapshot.baseDurationSec,
    loopSegments: undefined,
    loopSegment: undefined
  })

export const resolveEntryTimelineSecFromSourcePosition = (
  entry: TransportEntry,
  sourcePositionSec: number,
  startOffsetKind: 'source' | 'plan'
) => {
  const safeSourcePositionSec = Math.max(0, Number(sourcePositionSec) || 0)
  if (startOffsetKind === 'plan' && entry.playbackSequence?.segments?.length) {
    const baseTimeMap = createEntryBaseTimeMap(entry)
    const localSec = mapPlaybackSequencePlanToLocalSec({
      planSec: safeSourcePositionSec,
      sequence: entry.playbackSequence,
      mapSourceToBaseLocal: (sourceSec: number) => baseTimeMap.mapSourceToLocal(sourceSec)
    })
    return Number(entry.startSec) + localSec
  }
  const timeMap = createEntryBaseTimeMap(entry)
  const localSec = clampNumber(
    Number(timeMap.mapSourceToLocal(safeSourcePositionSec)) || 0,
    0,
    Math.max(0, Number(entry.duration) || 0)
  )
  return Number(entry.startSec) + localSec
}

export const resolveNodeRuntimeTimelineSec = (node: TrackGraphNode, timelineSec: number) => {
  const sourcePositionSec = node.source.resolvePlaybackPositionSec()
  if (sourcePositionSec === null) return null
  const playbackPositionSec = Number(sourcePositionSec)
  if (!Number.isFinite(playbackPositionSec) || playbackPositionSec < 0) return null
  const rawTimelineSec = resolveEntryTimelineSecFromSourcePosition(
    node.entry,
    playbackPositionSec,
    node.source.startOffsetKind
  )
  if (!Number.isFinite(rawTimelineSec)) return null
  const runtimeTimelineSec = Math.max(0, rawTimelineSec - resolveSourceLatencySec(node.source))
  if (Math.abs(runtimeTimelineSec - timelineSec) > MAX_SOURCE_CLOCK_DRIFT_SEC) return null
  return runtimeTimelineSec
}

export const resolveTransportAudibleTimelineSec = (
  timelineSec: number,
  nodes: TrackGraphNode[],
  masterTrackId: string
) => {
  const masterNode =
    nodes.find((node) => node.trackId === masterTrackId) ||
    nodes.find((node) => {
      const latencySec = resolveSourceLatencySec(node.source)
      const startSec = Number(node.entry.startSec) || 0
      const endSec = startSec + Math.max(0, Number(node.entry.duration) || 0) + latencySec
      return timelineSec >= startSec && timelineSec <= endSec
    }) ||
    null
  if (!masterNode) return timelineSec
  return resolveNodeRuntimeTimelineSec(masterNode, timelineSec) ?? timelineSec
}
